use super::{err, read_bounded, sha256, LabRoot};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;

const MAX_FIXTURE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Architecture {
    X86,
    X64,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Fingerprint {
    pub sha256: String,
    pub size: usize,
    pub architecture: Architecture,
}

pub(crate) fn fingerprint(bytes: &[u8]) -> Fingerprint {
    let architecture = (|| {
        if bytes.get(..2)? != b"MZ" {
            return None;
        }
        let offset = u32::from_le_bytes(bytes.get(0x3c..0x40)?.try_into().ok()?) as usize;
        let end = offset.checked_add(6)?;
        if bytes.get(offset..offset.checked_add(4)?)? != b"PE\0\0" {
            return None;
        }
        match u16::from_le_bytes(bytes.get(end - 2..end)?.try_into().ok()?) {
            0x14c => Some(Architecture::X86),
            0x8664 => Some(Architecture::X64),
            _ => None,
        }
    })()
    .unwrap_or(Architecture::Unknown);
    Fingerprint {
        sha256: sha256(bytes),
        size: bytes.len(),
        architecture,
    }
}

/// Independent verification results, supplied by an auditor. Matching the
/// sample hash never upgrades any of these fields to true.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProvenanceEvidence {
    pub source_commit_verified: bool,
    pub toolchain_record_verified: bool,
    pub patch_set_verified: bool,
    pub redistribution_license_verified: bool,
    pub artifact_signature_verified: bool,
}

impl ProvenanceEvidence {
    fn complete(&self) -> bool {
        self.source_commit_verified
            && self.toolchain_record_verified
            && self.patch_set_verified
            && self.redistribution_license_verified
            && self.artifact_signature_verified
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilityRequirement {
    pub name: String,
    pub expected_sha256: String,
    pub architecture: Architecture,
    pub compatibility_record_verified: bool,
    /// Counts from a separate read-only scanner. Every required pattern must
    /// have one exact full-length match; shortened/partial matches do not count.
    pub required_pattern_match_counts: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilityDecision {
    pub supported: bool,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeAuditReport {
    pub fingerprint: Fingerprint,
    pub provenance_verified: bool,
    pub capabilities: BTreeMap<String, CapabilityDecision>,
}

pub(crate) fn audit_runtime(
    bytes: &[u8],
    evidence: &ProvenanceEvidence,
    requirements: &[CapabilityRequirement],
) -> RuntimeAuditReport {
    let fingerprint = fingerprint(bytes);
    let provenance_verified = evidence.complete();
    let mut capabilities = BTreeMap::new();
    for requirement in requirements {
        let mut reasons = Vec::new();
        if !provenance_verified {
            reasons.push("PROVENANCE_UNVERIFIED".into());
        }
        if !requirement.compatibility_record_verified {
            reasons.push("COMPATIBILITY_UNVERIFIED".into());
        }
        if requirement.expected_sha256 != fingerprint.sha256 {
            reasons.push("HASH_MISMATCH".into());
        }
        if fingerprint.architecture == Architecture::Unknown
            || requirement.architecture != fingerprint.architecture
        {
            reasons.push("ARCHITECTURE_MISMATCH".into());
        }
        if requirement.required_pattern_match_counts.is_empty()
            || requirement
                .required_pattern_match_counts
                .iter()
                .any(|count| *count != 1)
        {
            reasons.push("REQUIRED_PATTERNS_NOT_UNIQUE_AND_COMPLETE".into());
        }
        if capabilities.contains_key(&requirement.name) {
            reasons.push("DUPLICATE_CAPABILITY".into());
        }
        capabilities.insert(
            requirement.name.clone(),
            CapabilityDecision {
                supported: reasons.is_empty(),
                reasons,
            },
        );
    }
    RuntimeAuditReport {
        fingerprint,
        provenance_verified,
        capabilities,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnedFilePlan {
    pub filename: String,
    pub original_sha256: Option<String>,
    pub replacement_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnedFileReceipt {
    pub plan: OwnedFilePlan,
    pub retained_original: Option<String>,
    pub restored: bool,
}

fn current_hash(lab: &LabRoot, filename: &str) -> Result<Option<String>, String> {
    lab.validate()?;
    let path = lab.file(filename)?;
    match read_bounded(&path, MAX_FIXTURE_BYTES) {
        Ok(bytes) => Ok(Some(sha256(&bytes))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(err(error)),
    }
}

pub(crate) fn plan_file(
    lab: &LabRoot,
    filename: &str,
    replacement: &[u8],
) -> Result<OwnedFilePlan, String> {
    if replacement.len() > MAX_FIXTURE_BYTES {
        return Err("Fixture exceeds laboratory size budget".into());
    }
    if filename == "lab-marker"
        || filename.starts_with("retained-")
        || filename.starts_with("stage-")
    {
        return Err("Reserved laboratory filename".into());
    }
    Ok(OwnedFilePlan {
        filename: filename.into(),
        original_sha256: current_hash(lab, filename)?,
        replacement_sha256: sha256(replacement),
    })
}

/// Deliberately one file, not a substitute for the production durable
/// transaction service. It demonstrates compare-before-write and exact restore.
pub(crate) fn apply_file(
    lab: &LabRoot,
    plan: &OwnedFilePlan,
    replacement: &[u8],
) -> Result<OwnedFileReceipt, String> {
    let checked = plan_file(lab, &plan.filename, replacement)?;
    if checked.original_sha256 != plan.original_sha256
        || checked.replacement_sha256 != plan.replacement_sha256
    {
        return Err("Plan drifted; no fixture file changed".into());
    }
    let retained_original = if let Some(expected) = &plan.original_sha256 {
        let bytes = read_bounded(&lab.file(&plan.filename)?, MAX_FIXTURE_BYTES).map_err(err)?;
        if sha256(&bytes) != *expected {
            return Err("Original changed before staging".into());
        }
        if bytes.len() > MAX_FIXTURE_BYTES {
            return Err("Original exceeds laboratory size budget".into());
        }
        let name = format!("retained-{}.blob", uuid::Uuid::new_v4());
        lab.write_new(&name, &bytes)?;
        Some(name)
    } else {
        None
    };
    if current_hash(lab, &plan.filename)? != plan.original_sha256 {
        return Err("Original changed after backup; retained good copy kept".into());
    }
    lab.write_atomic(&plan.filename, replacement)?;
    if current_hash(lab, &plan.filename)?.as_deref() != Some(&plan.replacement_sha256) {
        return Err("Replacement verification failed; retained good copy kept".into());
    }
    Ok(OwnedFileReceipt {
        plan: plan.clone(),
        retained_original,
        restored: false,
    })
}

pub(crate) fn restore_file(lab: &LabRoot, receipt: &mut OwnedFileReceipt) -> Result<(), String> {
    let current = current_hash(lab, &receipt.plan.filename)?;
    if receipt.restored {
        return if current == receipt.plan.original_sha256 {
            Ok(())
        } else {
            Err("Restored target subsequently drifted".into())
        };
    }
    if current.as_deref() != Some(&receipt.plan.replacement_sha256) {
        return Err("Target is no longer hash-owned; restore refused".into());
    }
    match (&receipt.retained_original, &receipt.plan.original_sha256) {
        (Some(name), Some(expected)) if name.starts_with("retained-") => {
            let original = read_bounded(&lab.file(name)?, MAX_FIXTURE_BYTES).map_err(err)?;
            if sha256(&original) != *expected {
                return Err("Retained original hash mismatch".into());
            }
            lab.write_atomic(&receipt.plan.filename, &original)?;
        }
        (None, None) => fs::remove_file(lab.file(&receipt.plan.filename)?).map_err(err)?,
        _ => return Err("Invalid restore receipt".into()),
    }
    if current_hash(lab, &receipt.plan.filename)? != receipt.plan.original_sha256 {
        return Err("Restored target verification failed".into());
    }
    receipt.restored = true;
    Ok(())
}

/// Health only reads bytes. It neither ensures/copies a runtime nor invokes a
/// CLI, and distinguishes a missing artifact from a verified artifact.
pub(crate) fn read_health(
    lab: &LabRoot,
    filename: &str,
    evidence: &ProvenanceEvidence,
    requirements: &[CapabilityRequirement],
) -> Result<Option<RuntimeAuditReport>, String> {
    lab.validate()?;
    match read_bounded(&lab.file(filename)?, MAX_FIXTURE_BYTES) {
        Ok(bytes) => Ok(Some(audit_runtime(&bytes, evidence, requirements))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(err(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pe(machine: u16) -> Vec<u8> {
        let mut bytes = vec![0; 256];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&128_u32.to_le_bytes());
        bytes[128..132].copy_from_slice(b"PE\0\0");
        bytes[132..134].copy_from_slice(&machine.to_le_bytes());
        bytes
    }

    fn evidence() -> ProvenanceEvidence {
        ProvenanceEvidence {
            source_commit_verified: true,
            toolchain_record_verified: true,
            patch_set_verified: true,
            redistribution_license_verified: true,
            artifact_signature_verified: true,
        }
    }

    fn requirement(bytes: &[u8]) -> CapabilityRequirement {
        CapabilityRequirement {
            name: "overlay".into(),
            expected_sha256: sha256(bytes),
            architecture: Architecture::X64,
            compatibility_record_verified: true,
            required_pattern_match_counts: vec![1, 1],
        }
    }

    #[test]
    fn hash_match_does_not_invent_provenance_and_capabilities_fail_independently() {
        let bytes = pe(0x8664);
        let first = requirement(&bytes);
        assert!(
            !audit_runtime(&bytes, &ProvenanceEvidence::default(), &[first.clone()]).capabilities
                ["overlay"]
                .supported
        );
        let mut second = first.clone();
        second.name = "cloud".into();
        second.required_pattern_match_counts = vec![1, 2];
        let report = audit_runtime(&bytes, &evidence(), &[first, second]);
        assert!(report.capabilities["overlay"].supported);
        assert!(!report.capabilities["cloud"].supported);
    }

    #[test]
    fn unknown_architecture_partial_patterns_and_same_size_tamper_are_rejected() {
        let bytes = pe(0x8664);
        let req = requirement(&bytes);
        let mut changed = bytes.clone();
        changed[200] = 1;
        assert_eq!(bytes.len(), changed.len());
        assert!(
            !audit_runtime(&changed, &evidence(), &[req.clone()]).capabilities["overlay"].supported
        );
        assert_eq!(fingerprint(&pe(0x14c)).architecture, Architecture::X86);
        assert_eq!(fingerprint(b"not a PE").architecture, Architecture::Unknown);
        for counts in [vec![], vec![0], vec![1, 0], vec![2]] {
            let mut incomplete = req.clone();
            incomplete.required_pattern_match_counts = counts;
            assert!(
                !audit_runtime(&bytes, &evidence(), &[incomplete]).capabilities["overlay"]
                    .supported
            );
        }
    }

    #[test]
    fn real_file_dry_run_apply_restore_retains_original_and_never_touches_unrelated() {
        let lab = LabRoot::create(&LabRoot::approved_parent()).unwrap();
        lab.write_new("target.dll", b"original bytes").unwrap();
        lab.write_new("unrelated.txt", b"user data").unwrap();
        let plan = plan_file(&lab, "target.dll", b"replacement").unwrap();
        assert_eq!(
            fs::read(lab.file("target.dll").unwrap()).unwrap(),
            b"original bytes"
        );
        let mut receipt = apply_file(&lab, &plan, b"replacement").unwrap();
        assert_eq!(
            fs::read(lab.file("target.dll").unwrap()).unwrap(),
            b"replacement"
        );
        restore_file(&lab, &mut receipt).unwrap();
        restore_file(&lab, &mut receipt).unwrap();
        assert_eq!(
            fs::read(lab.file("target.dll").unwrap()).unwrap(),
            b"original bytes"
        );
        assert_eq!(
            fs::read(lab.file("unrelated.txt").unwrap()).unwrap(),
            b"user data"
        );
        assert!(lab
            .file(receipt.retained_original.as_deref().unwrap())
            .unwrap()
            .is_file());
    }

    #[test]
    fn drift_and_tampered_backup_never_overwrite_external_bytes() {
        let lab = LabRoot::create(&LabRoot::approved_parent()).unwrap();
        lab.write_new("target.dll", b"original").unwrap();
        let plan = plan_file(&lab, "target.dll", b"managed!").unwrap();
        fs::write(lab.file("target.dll").unwrap(), b"external").unwrap();
        assert!(apply_file(&lab, &plan, b"managed!").is_err());
        let plan = plan_file(&lab, "target.dll", b"managed!").unwrap();
        let mut receipt = apply_file(&lab, &plan, b"managed!").unwrap();
        fs::write(
            lab.file(receipt.retained_original.as_deref().unwrap())
                .unwrap(),
            b"tampered",
        )
        .unwrap();
        assert!(restore_file(&lab, &mut receipt).is_err());
        assert_eq!(
            fs::read(lab.file("target.dll").unwrap()).unwrap(),
            b"managed!"
        );
        fs::write(lab.file("target.dll").unwrap(), b"useredit").unwrap();
        assert!(restore_file(&lab, &mut receipt).is_err());
        assert_eq!(
            fs::read(lab.file("target.dll").unwrap()).unwrap(),
            b"useredit"
        );
    }

    #[test]
    fn created_file_restore_is_exact_and_health_is_read_only() {
        let lab = LabRoot::create(&LabRoot::approved_parent()).unwrap();
        let before = fs::read_dir(lab.path()).unwrap().count();
        assert!(read_health(&lab, "missing.dll", &evidence(), &[])
            .unwrap()
            .is_none());
        assert_eq!(fs::read_dir(lab.path()).unwrap().count(), before);
        let bytes = pe(0x8664);
        let mut receipt =
            apply_file(&lab, &plan_file(&lab, "new.dll", &bytes).unwrap(), &bytes).unwrap();
        let before = fs::read_dir(lab.path()).unwrap().count();
        let report = read_health(&lab, "new.dll", &evidence(), &[requirement(&bytes)])
            .unwrap()
            .unwrap();
        assert!(report.capabilities["overlay"].supported);
        assert_eq!(fs::read_dir(lab.path()).unwrap().count(), before);
        restore_file(&lab, &mut receipt).unwrap();
        assert!(!lab.file("new.dll").unwrap().exists());
        assert!(plan_file(&lab, "../escape.dll", b"x").is_err());
        assert!(plan_file(&lab, "lab-marker", b"x").is_err());
    }
}
