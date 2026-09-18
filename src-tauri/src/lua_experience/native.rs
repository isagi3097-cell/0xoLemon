//! Verified, read-only SteamKit/PICS bridge for Lua metadata. It never uses Store jobs.
use super::store::regular_boundary;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

const OUTPUT_LIMIT: u64 = 2 * 1024 * 1024;
const PROCESS_TIMEOUT: Duration = Duration::from_secs(45);
// The launcher embeds the trust root; a writable runtime manifest cannot
// authorize a replacement executable merely by listing its new hash.
const PINNED_MANIFEST: &str = include_str!("../../resources/lua-steamkit/artifact-manifest.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    entry_point: String,
    files: Vec<Artifact>,
}
#[derive(Deserialize)]
struct Artifact {
    path: String,
    sha256: String,
    size: u64,
}

#[derive(Clone)]
pub(crate) struct NativeBridge {
    root: PathBuf,
}

impl NativeBridge {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn available(&self) -> bool {
        verify(&self.root, PINNED_MANIFEST).is_ok()
    }

    pub fn app_info(&self, appid: u32) -> Result<Value, String> {
        if appid == 0 {
            return Err("LUA_INVALID_APPID".into());
        }
        let verified = verify(&self.root, PINNED_MANIFEST)?;
        let request_id = uuid::Uuid::new_v4().to_string();
        let request =
            json!({"schemaVersion":1,"requestId":request_id,"operation":"appInfo","appid":appid});
        let mut command = private_command(&verified.entry, &self.root);
        let mut process = OwnedChild(command.spawn().map_err(|_| "LUA_STEAMKIT_START_FAILED")?);
        {
            let mut stdin = process.0.stdin.take().ok_or("LUA_STEAMKIT_STDIN")?;
            serde_json::to_writer(&mut stdin, &request).map_err(|_| "LUA_STEAMKIT_STDIN")?;
            stdin.write_all(b"\n").map_err(|_| "LUA_STEAMKIT_STDIN")?;
        }
        let stdout = process.0.stdout.take().ok_or("LUA_STEAMKIT_STDOUT")?;
        let (sender, receiver) = mpsc::sync_channel(1);
        let reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = stdout
                .take(OUTPUT_LIMIT + 1)
                .read_to_end(&mut bytes)
                .map(|_| bytes)
                .map_err(|_| "LUA_STEAMKIT_READ_FAILED");
            let _ = sender.send(result);
        });
        let deadline = Instant::now() + PROCESS_TIMEOUT;
        let mut output = None;
        let outcome = loop {
            if output.is_none() {
                match receiver.try_recv() {
                    Ok(Ok(bytes)) if bytes.len() as u64 <= OUTPUT_LIMIT => output = Some(bytes),
                    Ok(Ok(_)) => break Err("LUA_STEAMKIT_OUTPUT_LIMIT"),
                    Ok(Err(error)) => break Err(error),
                    Err(mpsc::TryRecvError::Disconnected) => break Err("LUA_STEAMKIT_READ_FAILED"),
                    Err(mpsc::TryRecvError::Empty) => (),
                }
            }
            match process.0.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => (),
                Err(_) => break Err("LUA_STEAMKIT_PROCESS_STATE"),
            }
            if Instant::now() >= deadline {
                break Err("LUA_STEAMKIT_TIMEOUT");
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        if outcome.is_err() {
            let _ = process.0.kill();
            let _ = process.0.wait();
        }
        // The pinned sidecar does not spawn descendants; EOF follows its exit.
        let _ = reader.join();
        let status = outcome.map_err(String::from)?;
        let output = match output {
            Some(bytes) => bytes,
            None => receiver
                .recv()
                .map_err(|_| "LUA_STEAMKIT_READ_FAILED")?
                .map_err(String::from)?,
        };
        let response = parse_response(&output, &request_id, appid)?;
        if !status.success() {
            return Err("LUA_STEAMKIT_PROCESS_FAILED".into());
        }
        Ok(response)
    }

    /// Private bounded NDJSON exchange. No frame is emitted to Tauri or logs here.
    /// The caller must validate identity and commit credentials only after successful exit.
    pub(crate) fn private_exchange(
        &self,
        request: &[u8],
        stopped: &dyn Fn() -> bool,
        timeout: Duration,
        mut on_frame: impl FnMut(&[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        if request.len() > 16 * 1024 || stopped() {
            return Err("LUA_STEAM_AUTH_CANCELLED".into());
        }
        let verified = verify(&self.root, PINNED_MANIFEST)?;
        let mut process = OwnedChild(
            private_command(&verified.entry, &self.root)
                .spawn()
                .map_err(|_| "LUA_STEAMKIT_START_FAILED")?,
        );
        // The child waits for stdin; place it in a kill-on-close job BEFORE sending
        // the request so a launcher crash cannot leave an authenticated CM session.
        #[cfg(windows)]
        let _job = AuthChildJob::attach(&process.0)?;
        let mut stdin = process.0.stdin.take().ok_or("LUA_STEAMKIT_STDIN")?;
        stdin
            .write_all(request)
            .and_then(|_| stdin.write_all(b"\n"))
            .map_err(|_| "LUA_STEAMKIT_STDIN")?;
        drop(stdin);
        let stdout = process.0.stdout.take().ok_or("LUA_STEAMKIT_STDOUT")?;
        let (sender, receiver) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            // At most 24 refreshed QR frames plus one terminal frame. The bounded
            // producer avoids a blocked sender during cancellation/child teardown.
            for _ in 0..26 {
                match read_private_frame(&mut reader) {
                    Ok(Some(bytes)) => {
                        if sender.send(Ok(bytes)).is_err() {
                            return;
                        }
                    }
                    Ok(None) => return,
                    Err(error) => {
                        let _ = sender.send(Err(error));
                        return;
                    }
                }
            }
            let _ = sender.send(Err("LUA_STEAM_AUTH_PROTOCOL_INVALID".into()));
        });
        let deadline = Instant::now() + timeout;
        let result = (|| {
            loop {
                if stopped() {
                    return Err("LUA_STEAM_AUTH_CANCELLED".into());
                }
                if Instant::now() >= deadline {
                    return Err("LUA_STEAM_AUTH_TIMEOUT".into());
                }
                while let Ok(frame) = receiver.try_recv() {
                    on_frame(&frame?)?;
                }
                if let Some(status) = process
                    .0
                    .try_wait()
                    .map_err(|_| "LUA_STEAMKIT_PROCESS_STATE")?
                {
                    // All pipe bytes are consumed before accepting a successful exit.
                    for frame in receiver.iter() {
                        on_frame(&frame?)?;
                    }
                    return if status.success() {
                        Ok(())
                    } else {
                        Err("LUA_STEAM_AUTH_FAILED".into())
                    };
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        })();
        if result.is_err() {
            let _ = process.0.kill();
            let _ = process.0.wait();
        }
        drop(receiver);
        let _ = reader.join();
        result
    }
}

fn read_private_frame(
    reader: &mut impl BufRead,
) -> Result<Option<zeroize::Zeroizing<Vec<u8>>>, String> {
    let mut frame = zeroize::Zeroizing::new(Vec::new());
    loop {
        let bytes = reader.fill_buf().map_err(|_| "LUA_STEAMKIT_READ_FAILED")?;
        if bytes.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err("LUA_STEAM_AUTH_PROTOCOL_INVALID".into())
            };
        }
        let end = bytes.iter().position(|b| *b == b'\n');
        let length = end.unwrap_or(bytes.len());
        if frame.len() + length > 16 * 1024 {
            return Err("LUA_STEAM_AUTH_PROTOCOL_INVALID".into());
        }
        frame.extend_from_slice(&bytes[..length]);
        reader.consume(length + usize::from(end.is_some()));
        if end.is_some() {
            return Ok(Some(frame));
        }
    }
}

fn private_command(entry: &Path, root: &Path) -> Command {
    let mut command = Command::new(entry);
    command
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for variable in [
        "DOTNET_STARTUP_HOOKS",
        "DOTNET_ADDITIONAL_DEPS",
        "DOTNET_SHARED_STORE",
        "DOTNET_ROOT",
        "DOTNET_ROOT_X64",
        "CORECLR_ENABLE_PROFILING",
        "CORECLR_PROFILER",
        "CORECLR_PROFILER_PATH",
        "CORECLR_PROFILER_PATH_64",
        "CORECLR_PROFILER_PATH_32",
        "COR_ENABLE_PROFILING",
        "COR_PROFILER",
        "COR_PROFILER_PATH",
        "COR_PROFILER_PATH_64",
        "COR_PROFILER_PATH_32",
    ] {
        command.env_remove(variable);
    }
    command.env("DOTNET_EnableDiagnostics", "0");
    command.env("DOTNET_MULTILEVEL_LOOKUP", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

#[cfg(windows)]
struct AuthChildJob(winapi::um::winnt::HANDLE);
#[cfg(windows)]
impl AuthChildJob {
    fn attach(child: &Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use winapi::um::{
            jobapi2::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject},
            winnt::{
                JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };
        let handle = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
        if handle.is_null() {
            return Err("LUA_STEAM_AUTH_PROCESS_ISOLATION_FAILED".into());
        }
        let job = Self(handle);
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of_val(&info) as u32,
            )
        } == 0
            || unsafe { AssignProcessToJobObject(handle, child.as_raw_handle() as _) } == 0
        {
            return Err("LUA_STEAM_AUTH_PROCESS_ISOLATION_FAILED".into());
        }
        Ok(job)
    }
}
#[cfg(windows)]
impl Drop for AuthChildJob {
    fn drop(&mut self) {
        unsafe {
            winapi::um::handleapi::CloseHandle(self.0);
        }
    }
}

struct Verified {
    entry: PathBuf,
    // Hold deny-write/delete handles through child exit to close the check/start
    // replacement window on Windows. These handles are not inherited by the child.
    _files: Vec<File>,
}

fn relative_file(value: &str) -> bool {
    !value.is_empty()
        && !value.contains(['\\', ':'])
        && Path::new(value)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        && value
            .split('/')
            .all(|part| !part.is_empty() && !part.ends_with(['.', ' ']))
}

fn verify(root: &Path, encoded: &str) -> Result<Verified, String> {
    regular_boundary(root).map_err(|_| "LUA_STEAMKIT_PATH_UNSAFE")?;
    let manifest: Manifest =
        serde_json::from_str(encoded).map_err(|_| "LUA_STEAMKIT_MANIFEST_INVALID")?;
    if manifest.schema_version != 1
        || manifest.entry_point != "0xoLemon.LuaSteamKit.exe"
        || manifest.files.is_empty()
        || manifest.files.len() > 512
    {
        return Err("LUA_STEAMKIT_MANIFEST_INVALID".into());
    }
    let mut paths = HashSet::new();
    let mut files = Vec::new();
    let mut total = 0u64;
    for artifact in &manifest.files {
        total = total
            .checked_add(artifact.size)
            .ok_or("LUA_STEAMKIT_MANIFEST_INVALID")?;
        if !relative_file(&artifact.path)
            || !paths.insert(artifact.path.to_ascii_lowercase())
            || artifact.size > 256 * 1024 * 1024
            || total > 512 * 1024 * 1024
            || artifact.sha256.len() != 64
            || !artifact.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("LUA_STEAMKIT_MANIFEST_INVALID".into());
        }
        let path = root.join(&artifact.path);
        regular_boundary(&path).map_err(|_| "LUA_STEAMKIT_PATH_UNSAFE")?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1); // FILE_SHARE_READ only.
        }
        let mut file = options
            .open(&path)
            .map_err(|_| "LUA_STEAMKIT_COMPONENT_MISSING")?;
        let meta = file
            .metadata()
            .map_err(|_| "LUA_STEAMKIT_COMPONENT_MISSING")?;
        if !meta.is_file() || meta.len() != artifact.size {
            return Err("LUA_STEAMKIT_INTEGRITY_FAILED".into());
        }
        let mut hash = Sha256::new();
        std::io::copy(&mut file, &mut hash).map_err(|_| "LUA_STEAMKIT_HASH_FAILED")?;
        if !hex::encode(hash.finalize()).eq_ignore_ascii_case(&artifact.sha256) {
            return Err("LUA_STEAMKIT_INTEGRITY_FAILED".into());
        }
        files.push(file);
    }
    if !paths.contains(&manifest.entry_point.to_ascii_lowercase()) {
        return Err("LUA_STEAMKIT_ENTRY_MISSING".into());
    }
    Ok(Verified {
        entry: root.join(manifest.entry_point),
        _files: files,
    })
}

fn parse_response(bytes: &[u8], request_id: &str, appid: u32) -> Result<Value, String> {
    if bytes.len() as u64 > OUTPUT_LIMIT {
        return Err("LUA_STEAMKIT_OUTPUT_LIMIT".into());
    }
    let response: Value =
        serde_json::from_slice(bytes).map_err(|_| "LUA_STEAMKIT_RESPONSE_INVALID")?;
    if response["schemaVersion"] != 1
        || response["requestId"] != request_id
        || response["appId"] != appid
        || response["source"] != "steamKit"
    {
        return Err("LUA_STEAMKIT_IDENTITY_MISMATCH".into());
    }
    if response["success"] != true {
        let code = response["errorCode"]
            .as_str()
            .filter(|code| {
                code.len() <= 128
                    && !code.is_empty()
                    && code
                        .bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            })
            .unwrap_or("LUA_STEAMKIT_REQUEST_FAILED");
        return Err(code.into());
    }
    let info = &response["appInfo"];
    if !info.is_object() {
        return Err("LUA_STEAMKIT_RESPONSE_INVALID".into());
    }
    Ok(info.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn private_frames_are_bounded_and_require_complete_lines() {
        let mut reader = std::io::Cursor::new(b"one\ntwo\n");
        assert_eq!(&*read_private_frame(&mut reader).unwrap().unwrap(), b"one");
        assert_eq!(&*read_private_frame(&mut reader).unwrap().unwrap(), b"two");
        assert!(read_private_frame(&mut reader).unwrap().is_none());
        assert!(read_private_frame(&mut std::io::Cursor::new(b"truncated")).is_err());
        assert!(read_private_frame(&mut std::io::Cursor::new(vec![b'x'; 16385])).is_err());
    }

    #[test]
    #[ignore = "Owned subprocess fixture for the Windows Job Object test"]
    fn owned_job_wait_helper() {
        std::thread::sleep(Duration::from_secs(30));
    }

    #[test]
    #[cfg(windows)]
    fn closing_auth_job_terminates_only_its_owned_child() {
        let executable = std::env::current_exe().unwrap();
        let mut command = private_command(&executable, executable.parent().unwrap());
        command.args([
            "--ignored",
            "--exact",
            "lua_experience::native::tests::owned_job_wait_helper",
        ]);
        let mut process = OwnedChild(command.spawn().unwrap());
        let job = AuthChildJob::attach(&process.0).unwrap();
        assert!(process.0.try_wait().unwrap().is_none());
        drop(job);
        let deadline = Instant::now() + Duration::from_secs(3);
        while process.0.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "owned child survived job close");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn native_response_is_bound_to_request_app_and_schema() {
        let good = json!({"schemaVersion":1,"requestId":"expected","source":"steamKit","appId":480,"success":true,"appInfo":{"appid":"480","common":{"name":"Spacewar"}}});
        assert_eq!(
            parse_response(&serde_json::to_vec(&good).unwrap(), "expected", 480).unwrap()["common"]
                ["name"],
            "Spacewar"
        );
        assert!(parse_response(&serde_json::to_vec(&good).unwrap(), "wrong", 480).is_err());
        assert!(parse_response(&serde_json::to_vec(&good).unwrap(), "expected", 440).is_err());
        let mut wrong = good.clone();
        wrong["source"] = json!("steamCmd");
        assert!(parse_response(&serde_json::to_vec(&wrong).unwrap(), "expected", 480).is_err());
    }

    #[test]
    fn native_errors_cannot_echo_provider_payloads_or_credentials() {
        let response = json!({"schemaVersion":1,"requestId":"r","source":"steamKit","appId":480,"success":false,"errorCode":"Bearer secret"});
        assert_eq!(
            parse_response(&serde_json::to_vec(&response).unwrap(), "r", 480).unwrap_err(),
            "LUA_STEAMKIT_REQUEST_FAILED"
        );
        for path in [
            "../other.exe",
            "C:/other.exe",
            "file:stream",
            "folder\\file.dll",
            "/game.exe",
            "folder/../x",
            "folder/file.",
        ] {
            assert!(!relative_file(path), "{path}");
        }
        assert!(relative_file("licenses/SteamKit2.txt"));
    }

    #[test]
    fn native_pins_detect_same_length_tampering_without_running_anything() {
        let root = std::env::temp_dir().join(format!("oxo-lua-native-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("0xoLemon.LuaSteamKit.exe");
        fs::write(&path, b"owned fixture").unwrap();
        let manifest = json!({"schemaVersion":1,"entryPoint":"0xoLemon.LuaSteamKit.exe","files":[{"path":"0xoLemon.LuaSteamKit.exe","size":13,"sha256":hex::encode(Sha256::digest(b"owned fixture"))}]}).to_string();
        assert!(verify(&root, &manifest).is_ok());
        fs::write(&path, b"other fixture").unwrap();
        assert_eq!(
            verify(&root, &manifest).err().unwrap(),
            "LUA_STEAMKIT_INTEGRITY_FAILED"
        );
        fs::remove_file(path).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
