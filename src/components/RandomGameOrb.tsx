import { useCallback, useEffect, useRef, useState } from 'react'
import './RandomGameOrb.css'
import { createGameVoiceRecognition, releaseMic, resolveGameVoiceCommand, warmUpMic, type VoiceGame } from './gameVoice'

interface Props {
  /** All installed/library game ids available to pick from */
  gameIds: string[]
  games?: VoiceGame[]
  /** Called with the randomly picked gameId */
  onPick: (gameId: string) => void
  /** Optional cover image of the last picked game */
  coverUrl?: string | null
  /** Optional tooltip label */
  label?: string
}

const ROLL_MS = 660
const HOLD_TO_TALK_MS = 340
// How long the post-roll "landed" flash stays lit for
const LANDED_MS = 460

export function RandomGameOrb({ gameIds, games = [], onPick, label }: Props) {
  const [rolling, setRolling] = useState(false)
  const [landed, setLanded] = useState(false)
  const [listening, setListening] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voiceTranscript, setVoiceTranscript] = useState('')
  const rollTimeout = useRef<number | null>(null)
  const landTimeout = useRef<number | null>(null)
  const holdTimeout = useRef<number | null>(null)
  const voiceRecognition = useRef<ReturnType<typeof createGameVoiceRecognition> | null>(null)
  const pressStarted = useRef(false)
  const voiceStarted = useRef(false)

  const clearHoldTimeout = useCallback(() => {
    if (holdTimeout.current) window.clearTimeout(holdTimeout.current)
    holdTimeout.current = null
  }, [])

  const pickRandomGame = useCallback(() => {
    if (rolling || gameIds.length === 0) return

    if (rollTimeout.current) window.clearTimeout(rollTimeout.current)
    if (landTimeout.current) window.clearTimeout(landTimeout.current)

    setLanded(false)
    setVoiceError(null)
    setRolling(true)

    rollTimeout.current = window.setTimeout(() => {
      const idx = Math.floor(Math.random() * gameIds.length)
      onPick(gameIds[idx])
      setRolling(false)
      setLanded(true)
      landTimeout.current = window.setTimeout(() => setLanded(false), LANDED_MS)
    }, ROLL_MS)
  }, [gameIds, onPick, rolling])

  const stopVoice = useCallback(() => {
    voiceRecognition.current?.stop()
    voiceRecognition.current = null
    setListening(false)
    releaseMic()
  }, [])

  const startVoice = useCallback(() => {
    if (rolling || games.length === 0) return
    voiceStarted.current = true
    setVoiceError(null)
    const recognition = createGameVoiceRecognition({
      onStart: () => setListening(true),
      onResult: ({ transcript, isFinal }) => {
        setVoiceTranscript(transcript)
        if (!isFinal) return
        const gameId = resolveGameVoiceCommand(transcript, games)
        if (gameId) {
          onPick(gameId)
          setLanded(true)
          landTimeout.current = window.setTimeout(() => setLanded(false), LANDED_MS)
          stopVoice()
        } else {
          setVoiceError('Game not found')
          stopVoice()
        }
      },
      onError: (error) => {
        setVoiceError(error === 'unsupported' ? 'Voice unavailable' : 'Could not hear that')
        setListening(false)
        voiceRecognition.current = null
      },
      onEnd: () => setListening(false),
    })
    voiceRecognition.current = recognition
    if (!recognition.start()) {
      voiceStarted.current = false
      voiceRecognition.current = null
    }
  }, [games, onPick, rolling, stopVoice])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (rolling || gameIds.length === 0) return
    void warmUpMic()
    if (typeof event.pointerId === 'number') event.currentTarget.setPointerCapture(event.pointerId)
    pressStarted.current = true
    voiceStarted.current = false
    setVoiceError(null)
    setVoiceTranscript('')
    clearHoldTimeout()
    holdTimeout.current = window.setTimeout(startVoice, HOLD_TO_TALK_MS)
  }, [clearHoldTimeout, gameIds.length, rolling, startVoice])

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (typeof event.pointerId === 'number' && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    clearHoldTimeout()
    if (!pressStarted.current) return
    pressStarted.current = false
    if (voiceStarted.current) {
      stopVoice()
      voiceStarted.current = false
      return
    }
    pickRandomGame()
  }, [clearHoldTimeout, pickRandomGame, stopVoice])

  const handlePointerCancel = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (typeof event.pointerId === 'number' && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    clearHoldTimeout()
    pressStarted.current = false
    if (voiceStarted.current) stopVoice()
    voiceStarted.current = false
  }, [clearHoldTimeout, stopVoice])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.repeat || (event.key !== ' ' && event.key !== 'Enter')) return
    event.preventDefault()
    handlePointerDown(event as unknown as React.PointerEvent<HTMLButtonElement>)
  }, [handlePointerDown])

  const handleKeyUp = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    handlePointerUp(event as unknown as React.PointerEvent<HTMLButtonElement>)
  }, [handlePointerUp])

  useEffect(() => () => {
    clearHoldTimeout()
    if (rollTimeout.current) window.clearTimeout(rollTimeout.current)
    if (landTimeout.current) window.clearTimeout(landTimeout.current)
    voiceRecognition.current?.abort()
  }, [clearHoldTimeout])

  const statusLabel = listening ? 'Listening for a game name' : voiceError ?? label ?? 'Discover a random game'

  return (
    <button
      type="button"
      className={`random-orb-btn${rolling ? ' is-rolling' : ''}${landed ? ' is-landed' : ''}${listening ? ' is-listening' : ''}${voiceError ? ' has-voice-error' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      title={statusLabel}
      aria-label={statusLabel}
      aria-pressed={listening}
      disabled={gameIds.length === 0}
    >
      <span className="random-orb-sphere">
        <span className="random-orb-plasma" aria-hidden="true">
          <span className="random-orb-ribbon random-orb-ribbon--cyan" />
          <span className="random-orb-ribbon random-orb-ribbon--violet" />
          <span className="random-orb-ribbon random-orb-ribbon--pink" />
          <span className="random-orb-speckles" />
        </span>
      </span>
      <span className="random-orb-flash" aria-hidden="true" />
      <span className="random-orb-wave" aria-hidden="true" />
      <span className="random-orb-status" aria-live="polite">{listening ? 'Listening' : voiceError}</span>
      {(listening || voiceError) && (
        <span className={`random-orb-voice-overlay${voiceError ? ' is-error' : ''}`} role="status" aria-live="polite">
          <span className="random-orb-voice-panel">
            <span className="random-orb-voice-kicker">{voiceError ? 'Voice input' : 'Listening'}</span>
            <span className="random-orb-voice-core" aria-hidden="true">
              <span className="random-orb-voice-ring random-orb-voice-ring--outer" />
              <span className="random-orb-voice-ring random-orb-voice-ring--inner" />
              <span className="random-orb-voice-bars">
                <i /><i /><i /><i /><i /><i /><i />
              </span>
            </span>
            <span className={`random-orb-voice-transcript${voiceTranscript ? '' : ' is-placeholder'}`}>
              {voiceError ?? (voiceTranscript || 'Say the name of a game')}
            </span>
            <span className="random-orb-voice-hint">Release to finish</span>
          </span>
        </span>
      )}
    </button>
  )
}
