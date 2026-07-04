'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'
import { Mic, Square, Loader2, RefreshCw, Volume2, VolumeX, Share2, Twitter, Copy, Lock } from 'lucide-react'

// ============ Types ============
type Phase = 'idle' | 'connecting' | 'narrating' | 'recording' | 'transcribing' | 'ended'

interface SubtitleChunk {
  seq: number
  text: string
  role: 'narrator' | 'user'
}

interface EndingMeta {
  title: string
  endingType: string
  verdict: string
}

interface SceneTemplateInfo {
  id: string
  category: string
  categoryZh: string
  categoryEn: string
}

interface CategoryInfo {
  key: string
  zh: string
  en: string
  count: number
}

// 類別 emoji 對照
const CATEGORY_EMOJI: Record<string, string> = {
  absurd_survival: '\u{1F300}',
  identity_reversal: '\u{1F3AD}',
  revenge_drama: '\u{2694}\u{FE0F}',
  high_stakes_romance: '\u{1F494}',
  workplace_betrayal: '\u{1F4BC}',
  family_secret: '\u{1F3DF}\u{FE0F}',
  fantasy_rebellion: '\u{1F52E}',
  social_humiliation: '\u{1F3AA}',
}

// ============ Constants ============
const AUDIO_PLAYBACK_RATE = 1.0
const DAILY_FREE_LIMIT = 5  // P0-2: aligned with server PER_IP_DAILY_LIMIT (was 3)
const STORAGE_KEY_DATE = 'lbb_date'
const STORAGE_KEY_COUNT = 'lbb_count'
const STORAGE_KEY_FOUNDER_TOKEN = 'lbb_founder_token'  // P0-3: founder token (never in URL after first load)

// ============ Helpers: Daily limit ============
function getDailyCount(): { date: string; count: number } {
  if (typeof window === 'undefined') return { date: '', count: 0 }
  const today = new Date().toISOString().slice(0, 10)
  const storedDate = localStorage.getItem(STORAGE_KEY_DATE) || ''
  const storedCount = parseInt(localStorage.getItem(STORAGE_KEY_COUNT) || '0', 10)
  if (storedDate !== today) {
    // 重置
    localStorage.setItem(STORAGE_KEY_DATE, today)
    localStorage.setItem(STORAGE_KEY_COUNT, '0')
    return { date: today, count: 0 }
  }
  return { date: today, count: storedCount }
}

function incrementDailyCount(): number {
  if (typeof window === 'undefined') return 0
  const { date, count } = getDailyCount()
  const newCount = count + 1
  localStorage.setItem(STORAGE_KEY_DATE, date)
  localStorage.setItem(STORAGE_KEY_COUNT, String(newCount))
  return newCount
}

// P0-3: Founder token — parse from URL (?founder=TOKEN), store in localStorage, clean URL
function getFounderToken(): string | null {
  if (typeof window === 'undefined') return null
  const urlParams = new URLSearchParams(window.location.search)
  const urlToken = urlParams.get('founder')
  if (urlToken) {
    localStorage.setItem(STORAGE_KEY_FOUNDER_TOKEN, urlToken)
    // Clean URL — remove token to avoid leaking via sharing/referrer
    const newUrl = window.location.pathname
    window.history.replaceState({}, '', newUrl)
    return urlToken
  }
  return localStorage.getItem(STORAGE_KEY_FOUNDER_TOKEN)
}

// ============ Component ============
export default function VoiceGamePage() {
  // === State ===
  const [phase, setPhase] = useState<Phase>('idle')
  const [connected, setConnected] = useState(false)
  const [subtitles, setSubtitles] = useState<SubtitleChunk[]>([])
  const [turn, setTurn] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recordSeconds, setRecordSeconds] = useState(0)
  const [narrationText, setNarrationText] = useState('') // 即時累積的旁白
  const [endingMeta, setEndingMeta] = useState<EndingMeta | null>(null)
  const [dailyCount, setDailyCount] = useState(0)
  const [copied, setCopied] = useState(false)
  const [sceneTemplate, setSceneTemplate] = useState<SceneTemplateInfo | null>(null)
  const [categories, setCategories] = useState<CategoryInfo[]>([])
  // P1: text-only fallback mode（TTS circuit breaker 觸發）
  const [ttsMode, setTtsMode] = useState<'voice' | 'text_only'>('voice')
  const [ttsModeReason, setTtsModeReason] = useState<string>('')
  // P0-3: founder mode tracking
  const [userMode, setUserMode] = useState<'founder' | 'public'>('public')

  // ====== P0-1: generation tracking ======
  // currentGenerationId：前端只接受符合這個 ID 的 text/audio chunk，舊的全部 discard
  const currentGenerationIdRef = useRef<string>('')
  const currentTurnIdRef = useRef<number>(0)
  // 用 ref 而不是 state，避免 re-render race condition
  const [serverQuota, setServerQuota] = useState<{
    perIpRemaining: number
    perIpLimit: number
    betaDisabled: boolean
  } | null>(null)

  // === Refs ===
  const socketRef = useRef<Socket | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioQueueRef = useRef<Map<number, string>>(new Map()) // seq -> base64
  const nextPlaySeqRef = useRef<number>(0)
  const currentlyPlayingSeqRef = useRef<number | null>(null)
  const isPlayingRef = useRef<boolean>(false)
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const playLoopRunningRef = useRef<boolean>(false)
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const phaseRef = useRef<Phase>('idle')
  const streamRef = useRef<MediaStream | null>(null)
  // 用來中斷正在 await 的 audio 播放 promise
  const interruptResolverRef = useRef<(() => void) | null>(null)
  // P0-postgame-fix: flag to discard late audio_chunk after game_over
  // Set true on game_over, reset false on start_game / generation_start
  const gameEndedRef = useRef<boolean>(false)

  // Helper: update both phase state and ref
  const setPhaseSafe = useCallback((p: Phase) => {
    phaseRef.current = p
    setPhase(p)
  }, [])

  // ============ Audio Queue Player ============
  // 收到 audio_chunk 就放進 queue；按 seq 順序連續播放
  const tryPlayNext = useCallback(async () => {
    if (playLoopRunningRef.current) return
    if (isPlayingRef.current) return
    playLoopRunningRef.current = true
    try {
      while (true) {
        const nextSeq = nextPlaySeqRef.current
        const audioB64 = audioQueueRef.current.get(nextSeq)
        if (!audioB64) break

        audioQueueRef.current.delete(nextSeq)
        nextPlaySeqRef.current = nextSeq + 1
        isPlayingRef.current = true
        currentlyPlayingSeqRef.current = nextSeq
        setIsPlaying(true)

        // 播放這個 chunk
        const audioUrl = `data:audio/wav;base64,${audioB64}`
        const audio = audioElRef.current ?? new Audio()
        audioElRef.current = audio
        audio.src = audioUrl
        audio.playbackRate = AUDIO_PLAYBACK_RATE
        audio.muted = muted

        let interrupted = false
        await new Promise<void>((resolve) => {
          // 註冊 resolver，讓 interruptPlayback 可以中斷
          interruptResolverRef.current = () => {
            interrupted = true
            resolve()
          }
          const onEnded = () => {
            audio.removeEventListener('ended', onEnded)
            audio.removeEventListener('error', onError)
            interruptResolverRef.current = null
            resolve()
          }
          const onError = () => {
            audio.removeEventListener('ended', onEnded)
            audio.removeEventListener('error', onError)
            interruptResolverRef.current = null
            resolve()
          }
          audio.addEventListener('ended', onEnded)
          audio.addEventListener('error', onError)
          audio.play().catch(onError)
        })

        isPlayingRef.current = false
        currentlyPlayingSeqRef.current = null
        setIsPlaying(false)

        // 如果中途被中斷（player-interrupt），停止整個 loop
        if (interrupted) break
      }
    } finally {
      playLoopRunningRef.current = false
    }
  }, [muted])

  // 收到 audio_chunk — P0-1: 檢查 generationId，舊的 discard
  // P0-postgame-fix: also discard if game has ended (late TTS promises still emitting)
  const handleAudioChunk = useCallback((payload: {
    sessionId?: string
    turnId?: number
    generationId?: string
    seq: number
    audio: string
    format: string
  }) => {
    // P0-postgame-fix: game already ended, discard late audio
    if (gameEndedRef.current) {
      console.debug(`[discard audio] game ended, ignoring seq=${payload.seq}`)
      return
    }
    // 如果帶了 generationId 且不是當前 generation，直接 discard
    if (payload.generationId && payload.generationId !== currentGenerationIdRef.current) {
      console.debug(`[discard audio] gen ${payload.generationId.slice(0,8)} ≠ current ${currentGenerationIdRef.current.slice(0,8)}`)
      return
    }
    audioQueueRef.current.set(payload.seq, payload.audio)
    tryPlayNext()
  }, [tryPlayNext])

  // 中斷所有播放（搶話時呼叫）
  const interruptPlayback = useCallback(() => {
    // 清空 queue
    audioQueueRef.current.clear()
    nextPlaySeqRef.current = 0
    isPlayingRef.current = false
    currentlyPlayingSeqRef.current = null
    setIsPlaying(false)
    // 停止當前 audio
    if (audioElRef.current) {
      audioElRef.current.pause()
      audioElRef.current.src = ''
    }
    // 解開正在 await 的播放 promise（讓 playLoop 跳出）
    if (interruptResolverRef.current) {
      const resolver = interruptResolverRef.current
      interruptResolverRef.current = null
      resolver()
    }
  }, [])

  // ============ Socket ============
  useEffect(() => {
    const socket = io('/?XTransformPort=3003', {
      transports: ['websocket'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 5,
      timeout: 8000,
      auth: { founderToken: getFounderToken() },  // P0-3: send founder token via socket auth
    })
    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      socket.emit('list_categories')
    })
    socket.on('disconnect', () => {
      setConnected(false)
      // P0-6: disconnect fallback — 顯示提示但不要清空遊戲狀態（讓 reconnect 後可恢復）
      setError('連線中斷，正在嘗試重新連線...')
    })
    socket.on('reconnect', () => {
      setError(null)
    })

    socket.on('categories_list', (data: { categories: CategoryInfo[] }) => {
      setCategories(data.categories)
    })

    // P0-1: 接收 connected 事件（含 quota 資訊 + userMode, P0-3）
    socket.on('connected', (data: {
      sessionId: string
      anonUserId?: string
      quota?: {
        perIpRemaining: number
        perIpLimit: number
        betaDisabled: boolean
        globalRemaining: number
        globalLimit: number
        userMode?: 'founder' | 'public'
        founderModeEnabled?: boolean
      }
      userMode?: 'founder' | 'public'
    }) => {
      if (data.quota) {
        setServerQuota({
          perIpRemaining: data.quota.perIpRemaining,
          perIpLimit: data.quota.perIpLimit,
          betaDisabled: data.quota.betaDisabled,
        })
      }
      if (data.userMode) {
        setUserMode(data.userMode)
        console.log(`[connected] userMode=${data.userMode}`)
      }
    })

    // P0-1: text_chunk 帶 generationId，舊的 discard
    socket.on('text_chunk', (data: {
      sessionId?: string
      turnId?: number
      generationId?: string
      seq: number
      text: string
    }) => {
      if (data.generationId && data.generationId !== currentGenerationIdRef.current) {
        console.debug(`[discard text] gen ${data.generationId.slice(0,8)} ≠ current ${currentGenerationIdRef.current.slice(0,8)}`)
        return
      }
      setSubtitles(prev => [...prev, { seq: data.seq, text: data.text, role: 'narrator' }])
      setNarrationText(prev => prev + (prev ? '' : '') + data.text)
    })

    socket.on('audio_chunk', handleAudioChunk)

    socket.on('user_text', (data: { text: string; generationId?: string }) => {
      // user_text 不需要 generation filter（玩家自己的話永遠顯示）
      setSubtitles(prev => [...prev, { seq: Date.now(), text: data.text, role: 'user' }])
    })

    // P0-1: turn_start 帶 generationId，更新 currentGenerationId
    socket.on('turn_start', (data: {
      sessionId?: string
      turnId?: number
      generationId?: string
      turn: number
    }) => {
      if (data.generationId) {
        currentGenerationIdRef.current = data.generationId
        console.debug(`[turn_start] new gen=${data.generationId.slice(0,8)}`)
      }
      if (typeof data.turnId === 'number') currentTurnIdRef.current = data.turnId
      setTurn(data.turn)
      setNarrationText('')
    })

    // P0-1: generation_start — server emits this BEFORE ASR, so we update our ref early
    // (prevents error_msg from being discarded when ASR fails — fixes "stuck in 理解中" race)
    // P0-fix-audio: also reset audio playback state here, to clear any stale audio from
    // previous turn's background TTS that sneaked in between interruptPlayback (startRecording)
    // and generation_start (server response). Without this, nextPlaySeqRef gets incremented
    // by stale audio, causing turn N's audio to be out of sync → choppy playback from turn 3+.
    socket.on('generation_start', (data: {
      sessionId?: string
      turnId?: number
      generationId: string
    }) => {
      console.debug(`[generation_start] new gen=${data.generationId.slice(0,8)}, resetting audio state`)
      // Reset audio playback state BEFORE updating generationId,
      // so any in-flight audio_chunk from old generation is cleanly discarded
      interruptPlayback()
      // P0-postgame-fix: new generation means game is in progress, clear ended flag
      gameEndedRef.current = false
      currentGenerationIdRef.current = data.generationId
      if (typeof data.turnId === 'number') currentTurnIdRef.current = data.turnId
    })

    socket.on('scene_template', (data: SceneTemplateInfo & { generationId?: string }) => {
      setSceneTemplate(data)
    })

    // P1: 接收 TTS circuit breaker 狀態
    socket.on('tts_status', (data: {
      sessionId?: string
      turnId?: number
      generationId?: string
      mode: 'voice' | 'text_only'
      reason?: string
      retryAfterMs?: number
    }) => {
      if (data.generationId && data.generationId !== currentGenerationIdRef.current) return
      console.warn(`[tts_status] mode=${data.mode} reason=${data.reason}`)
      setTtsMode(data.mode)
      setTtsModeReason(data.reason || '')
      // 5 分鐘後自動恢復（如果 server 沒有再送 close 事件）
      if (data.mode === 'text_only' && data.retryAfterMs) {
        setTimeout(() => {
          setTtsMode('voice')
          setTtsModeReason('')
        }, Math.min(data.retryAfterMs, 5 * 60 * 1000))
      }
    })

    // P0-1: turn_complete 帶 generationId，舊的 discard
    socket.on('turn_complete', (data: {
      sessionId?: string
      turnId?: number
      generationId?: string
      turn: number
      isEnding: boolean
    }) => {
      if (data.generationId && data.generationId !== currentGenerationIdRef.current) {
        console.debug(`[discard turn_complete] gen ${data.generationId.slice(0,8)}`)
        return
      }
      if (typeof data.turn === 'number') setTurn(data.turn)
      setPhaseSafe('idle')
    })

    socket.on('game_over', (data: {
      sessionId?: string
      turnId?: number
      generationId?: string
      ending?: string
      meta?: EndingMeta
    }) => {
      // P0-fix1: discard stale generation's game_over（避免舊局晚到的 game_over 結束新局）
      if (data.generationId && data.generationId !== currentGenerationIdRef.current) {
        console.debug(`[discard game_over] gen ${data.generationId.slice(0,8)} ≠ current ${currentGenerationIdRef.current.slice(0,8)}`)
        return
      }
      // P0-postgame-fix: mark game ended + stop any in-flight audio
      // Late audio_chunk from server's pending TTS promises will be discarded by handleAudioChunk
      gameEndedRef.current = true
      interruptPlayback()
      console.log(`[game_over] ending=${data.ending || 'auto'}, audio queue cleared, late audio will be discarded`)
      if (data?.meta) {
        setEndingMeta(data.meta)
      }
      setPhaseSafe('ended')
    })

    socket.on('status', (data: { stage: string; generationId?: string }) => {
      // P0-1: always update generationId ref first (belt and suspenders, so error_msg is never orphaned)
      if (data.generationId) {
        currentGenerationIdRef.current = data.generationId
      }
      if (data.stage === 'transcribing') {
        setPhaseSafe('transcribing')
      }
    })

    socket.on('error_msg', (data: { message: string; code?: string; generationId?: string }) => {
      // P0-1: when in transcribing phase, accept error_msg even if generationId mismatches
      // (prevents "stuck in 理解中" when ASR fails with new generationId that frontend hasn't seen)
      if (data.generationId && data.generationId !== currentGenerationIdRef.current) {
        if (phaseRef.current !== 'transcribing') {
          console.debug(`[discard error_msg] gen ${data.generationId.slice(0,8)} ≠ current ${currentGenerationIdRef.current.slice(0,8)}`)
          return
        }
        // In transcribing: accept the error, update ref to match
        console.debug(`[error_msg] accepting in transcribing, updating gen ${data.generationId.slice(0,8)}`)
        currentGenerationIdRef.current = data.generationId
      }
      setError(data.message)
      setPhaseSafe('idle')
    })

    socket.on('reset_ok', () => {
      setSubtitles([])
      setTurn(0)
      setNarrationText('')
      setEndingMeta(null)
      setSceneTemplate(null)
      setTtsMode('voice')
      setTtsModeReason('')
      currentGenerationIdRef.current = ''
      currentTurnIdRef.current = 0
      setPhaseSafe('idle')
      setError(null)
      interruptPlayback()
    })

    return () => {
      socket.disconnect()
    }
  }, [handleAudioChunk, interruptPlayback, setPhaseSafe])

  // ============ Daily count: 載入 + 每分鐘檢查重置 ============
  useEffect(() => {
    const { count } = getDailyCount()
    setDailyCount(count)
    const interval = setInterval(() => {
      const { count: c } = getDailyCount()
      setDailyCount(c)
    }, 60000)
    return () => clearInterval(interval)
  }, [])

  // P0-1: 30s safety timeout for transcribing phase (prevents permanent "理解中" stuck state)
  useEffect(() => {
    if (phase !== 'transcribing') return
    const timer = setTimeout(() => {
      if (phaseRef.current === 'transcribing') {
        console.warn('[timeout] transcribing phase exceeded 30s, resetting to idle')
        setError('命運線路短暫打結，請重新敲門。')
        setPhaseSafe('idle')
      }
    }, 30000)
    return () => clearTimeout(timer)
  }, [phase, setPhaseSafe])

  // ============ Recording ============
  const startRecording = useCallback(async () => {
    setError(null)
    // 搶話中斷：立刻停止當前播放
    interruptPlayback()

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
      })
      streamRef.current = stream
      audioChunksRef.current = []

      // 偏好用 webm/opus，向下相容
      let mimeType = 'audio/webm;codecs=opus'
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/webm'
      }
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/ogg'
      }
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = ''
      }

      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data)
        }
      }

      recorder.start(250) // 每 250ms 切一塊，確保及時上傳
      setPhaseSafe('recording')
      setRecordSeconds(0)
      recordTimerRef.current = setInterval(() => {
        setRecordSeconds(s => s + 1)
      }, 1000)
    } catch (err) {
      console.error('getUserMedia failed', err)
      setError('無法存取麥克風：' + String(err))
      setPhaseSafe('idle')
    }
  }, [interruptPlayback, setPhaseSafe])

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') {
      setPhaseSafe('idle')
      return
    }

    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }

    recorder.onstop = async () => {
      // 停止 stream tracks
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
        streamRef.current = null
      }

      const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
      if (blob.size === 0) {
        setError('錄音為空')
        setPhaseSafe('idle')
        return
      }

      // 轉 base64
      const reader = new FileReader()
      reader.onloadend = () => {
        const result = reader.result as string
        const base64 = result.split(',')[1]
        if (socketRef.current?.connected) {
          socketRef.current.emit('submit_audio', { audio: base64, format: recorder.mimeType })
          setPhaseSafe('transcribing')
        } else {
          setError('未連線')
          setPhaseSafe('idle')
        }
      }
      reader.readAsDataURL(blob)
    }

    recorder.stop()
  }, [setPhaseSafe])

  // ============ Game Actions ============
  const startGame = useCallback((category?: string) => {
    // P0-2/P0-3: founder mode skips local quota check (server is source of truth)
    // P0-2: public mode uses serverQuota when available, falls back to local count
    if (userMode !== 'founder') {
      const remaining = serverQuota?.perIpRemaining ?? Math.max(0, DAILY_FREE_LIMIT - getDailyCount().count)
      if (remaining <= 0) {
        setError(`今日已玩 ${DAILY_FREE_LIMIT} 局免費額度，明天再來吧。`)
        return
      }
    }
    setError(null)
    setSubtitles([])
    setNarrationText('')
    setEndingMeta(null)
    setSceneTemplate(null)
    setTtsMode('voice')
    setTtsModeReason('')
    setTurn(0)
    interruptPlayback()
    nextPlaySeqRef.current = 0
    // P0-postgame-fix: new game starting, clear ended flag so audio plays normally
    gameEndedRef.current = false
    setPhaseSafe('narrating')
    // 開局時 increment
    const newCount = incrementDailyCount()
    setDailyCount(newCount)
    socketRef.current?.emit('start_game', category ? { category } : {})
  }, [interruptPlayback, setPhaseSafe, userMode, serverQuota])

  const resetGame = useCallback(() => {
    interruptPlayback()
    nextPlaySeqRef.current = 0
    setSceneTemplate(null)
    setTtsMode('voice')
    setTtsModeReason('')
    socketRef.current?.emit('reset_game')
  }, [interruptPlayback])

  // ============ Share helpers ============
  const buildShareText = useCallback(() => {
    if (!endingMeta) return ''
    const opening = subtitles.find(s => s.role === 'narrator')?.text || ''
    const ending = subtitles.filter(s => s.role === 'narrator').slice(-1)[0]?.text || ''
    const categoryLabel = sceneTemplate ? ` · ${sceneTemplate.categoryZh}` : ''
    return `【人生盲盒${categoryLabel} · ${endingMeta.endingType}】${endingMeta.title}

開場：${opening.slice(0, 50)}${opening.length > 50 ? '...' : ''}

結局：${ending.slice(0, 50)}${ending.length > 50 ? '...' : ''}

AI 判詞：${endingMeta.verdict}

你的人生，5 分鐘一局：
https://preview-chat-ee6d98a4-ca67-4526-b626-44c9cb958846.space-z.ai/`
  }, [endingMeta, subtitles, sceneTemplate])

  // P0-3: emit share_clicked event for usage logging
  const emitShareClicked = useCallback(() => {
    socketRef.current?.emit('share_clicked', {
      turnId: currentTurnIdRef.current,
      generationId: currentGenerationIdRef.current,
    })
  }, [])

  const handleShareTwitter = useCallback(() => {
    const text = buildShareText()
    if (!text) return
    emitShareClicked()
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank')
  }, [buildShareText, emitShareClicked])

  const handleShareCopy = useCallback(async () => {
    const text = buildShareText()
    if (!text) return
    emitShareClicked()
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [buildShareText, emitShareClicked])

  const handleShareNative = useCallback(async () => {
    const text = buildShareText()
    if (!text) return
    emitShareClicked()
    if (navigator.share) {
      try {
        await navigator.share({ title: '人生盲盒', text })
      } catch {
        // 用戶取消
      }
    } else {
      handleShareCopy()
    }
  }, [buildShareText, handleShareCopy, emitShareClicked])

  // ============ Render ============
  const canRecord = connected && (phase === 'idle' || phase === 'narrating' || phase === 'transcribing')
  // P0-2: server is source of truth for quota; fall back to local count for SSR/initial
  const effectiveLimit = serverQuota?.perIpLimit || DAILY_FREE_LIMIT
  const remainingToday = userMode === 'founder'
    ? (serverQuota?.perIpRemaining ?? 100)
    : (serverQuota?.perIpRemaining ?? Math.max(0, DAILY_FREE_LIMIT - dailyCount))
  const isOutOfCredits = remainingToday === 0 && phase === 'idle' && subtitles.length === 0
  const openingText = subtitles.find(s => s.role === 'narrator')?.text || ''
  const endingText = subtitles.filter(s => s.role === 'narrator').slice(-1)[0]?.text || ''

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center justify-between p-6 relative overflow-hidden">
      {/* Background ambient glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[80vmin] h-[80vmin] rounded-full blur-3xl transition-all duration-1000 ${
          phase === 'recording' ? 'bg-red-900/30 scale-110' :
          isPlaying ? 'bg-amber-900/30 scale-110' :
          phase === 'narrating' ? 'bg-indigo-900/20 scale-105' :
          phase === 'ended' && endingMeta ? 'bg-purple-900/20 scale-105' :
          'bg-zinc-800/20 scale-100'
        }`} />
      </div>

      {/* Header */}
      <header className="w-full max-w-3xl flex items-center justify-between relative z-10">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500'} animate-pulse`} />
          <span className="text-xs text-zinc-400 tracking-widest uppercase">
            {connected ? 'CONNECTED' : 'CONNECTING...'}
          </span>
          {sceneTemplate && phase !== 'idle' && (
            <span className="text-xs text-amber-400/70 tracking-widest">
              · {sceneTemplate.categoryZh}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              const newMuted = !muted
              setMuted(newMuted)
              if (audioElRef.current) audioElRef.current.muted = newMuted
            }}
            className="text-zinc-400 hover:text-white transition-colors"
            aria-label="toggle mute"
          >
            {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <span className="text-xs text-zinc-500 tracking-widest">
            TURN {turn} / 5
          </span>
          {userMode === 'founder' && (
            <span className="text-xs tracking-widest text-amber-300 bg-amber-950/40 border border-amber-800/50 px-2 py-0.5 rounded-full">
              FOUNDER
            </span>
          )}
          <span className={`text-xs tracking-widest ${remainingToday === 0 ? 'text-red-400' : remainingToday === 1 ? 'text-amber-400' : 'text-zinc-500'}`}>
            · {remainingToday}/{effectiveLimit} LEFT
          </span>
        </div>
      </header>

      {/* Main: subtitle / status */}
      <main className="w-full max-w-3xl flex-1 flex flex-col items-center justify-center relative z-10 py-8">
        {/* Idle / Initial screen */}
        {phase === 'idle' && subtitles.length === 0 && (
          <div className="text-center space-y-6">
            <div className="space-y-2">
              <h1 className="text-5xl md:text-7xl font-serif font-bold tracking-tight">
                人生盲盒
              </h1>
              <p className="text-zinc-400 text-sm tracking-[0.3em] uppercase">Life · Blind · Box</p>
            </div>
            <p className="text-zinc-500 max-w-md mx-auto text-sm leading-relaxed">
              每次開局都是一個隨機人生。5 分鐘、3-5 輪對話，沒有存檔、沒有重來。
              <br />按住下方按鈕說話，鬆手送出。
            </p>
            {isOutOfCredits ? (
              <div className="space-y-3 mt-4">
                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-500 text-sm">
                  <Lock size={14} />
                  今日免費額度已用完
                </div>
                <p className="text-xs text-zinc-600">明天再來，或之後解鎖更多劇情包</p>
              </div>
            ) : (
              <>
                <button
                  onClick={() => startGame()}
                  disabled={!connected}
                  className="mt-4 px-8 py-3 rounded-full bg-white text-black font-medium tracking-wider hover:bg-zinc-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  開啟盲盒
                </button>

                {/* 類別選擇 */}
                {categories.length > 0 && (
                  <div className="mt-8">
                    <p className="text-xs text-zinc-600 tracking-widest mb-3">
                      或選擇類別
                    </p>
                    <div className="flex flex-wrap justify-center gap-2 max-w-md mx-auto">
                      {categories.map((cat) => (
                        <button
                          key={cat.key}
                          onClick={() => startGame(cat.key)}
                          disabled={!connected}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs hover:bg-zinc-800 hover:border-zinc-700 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <span>{CATEGORY_EMOJI[cat.key] || '\u{1F3AF}'}</span>
                          <span>{cat.zh}</span>
                          <span className="text-zinc-600">{cat.count}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
            {userMode !== 'founder' && remainingToday > 0 && remainingToday < effectiveLimit && (
              <p className="text-xs text-zinc-600 tracking-widest">
                今日剩餘 {remainingToday} 局免費
              </p>
            )}
          </div>
        )}

        {/* Narration / Subtitles display */}
        {(phase !== 'idle' || subtitles.length > 0) && phase !== 'ended' && (
          <div className="w-full space-y-6">
            {/* P1: text-only fallback 提示（不是 error，是「AI 嗆聲中」） */}
            {ttsMode === 'text_only' && (
              <div className="text-center">
                <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-amber-950/40 border border-amber-800/50 text-amber-300 text-xs tracking-widest">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  AI 嗆聲中，先用字幕模式演出
                </span>
              </div>
            )}

            {/* 即時旁白字幕 */}
            <div className="min-h-[120px] flex items-center justify-center">
              <p className={`text-center leading-relaxed max-w-2xl ${
                ttsMode === 'text_only'
                  ? 'text-2xl md:text-3xl font-serif text-amber-100'  // 字幕模式：放大加亮
                  : 'text-2xl md:text-3xl font-serif text-zinc-100'
              }`}>
                {narrationText || (
                  <span className="text-zinc-600 text-base">
                    {phase === 'transcribing' ? '正在理解你的話...' :
                     phase === 'narrating' ? '正在編織劇情...' :
                     phase === 'recording' ? '正在聆聽...' :
                     ''}
                  </span>
                )}
                {phase === 'narrating' && narrationText && (
                  <span className="inline-block w-1 h-6 bg-amber-400 ml-1 animate-pulse" />
                )}
              </p>
            </div>

            {/* Recording indicator */}
            {phase === 'recording' && (
              <div className="flex flex-col items-center gap-2">
                <div className="flex items-center gap-2 text-red-400">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  <span className="text-xs tracking-widest">RECORDING · {recordSeconds}s</span>
                </div>
              </div>
            )}

            {/* History (collapsible) */}
            {subtitles.length > 1 && (
              <details className="mt-8 text-sm">
                <summary className="text-zinc-500 cursor-pointer hover:text-zinc-300 transition-colors">
                  查看完整對話紀錄（{subtitles.length}）
                </summary>
                <div className="mt-4 space-y-3 max-h-64 overflow-y-auto text-left pr-2">
                  {subtitles.map((s, i) => (
                    <div key={i} className={`text-sm leading-relaxed ${s.role === 'user' ? 'text-amber-300/80' : 'text-zinc-400'}`}>
                      <span className="text-xs text-zinc-600 mr-2">
                        {s.role === 'user' ? '你' : '旁白'}
                      </span>
                      {s.text}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {error && (
              <div className="text-red-400 text-sm text-center">
                {error}
              </div>
            )}
          </div>
        )}

        {/* Ended screen with share card */}
        {phase === 'ended' && (
          <div className="text-center space-y-6">
            <p className="text-zinc-500 text-sm tracking-[0.3em] uppercase">The End</p>

            {/* 場景類別標籤 */}
            {sceneTemplate && (
              <p className="text-xs text-zinc-600 tracking-widest">
                {sceneTemplate.categoryZh} · {sceneTemplate.categoryEn}
              </p>
            )}

            {/* 結局分享卡 */}
            {endingMeta ? (
              <div className="max-w-md mx-auto">
                <div className="relative rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-900 via-black to-zinc-900 p-8 shadow-2xl overflow-hidden">
                  {/* 裝飾光 */}
                  <div className={
                    'absolute -top-20 -right-20 w-40 h-40 rounded-full blur-3xl opacity-30 ' +
                    (endingMeta.endingType === '好結局'
                      ? 'bg-emerald-500'
                      : endingMeta.endingType === '壞結局'
                      ? 'bg-red-500'
                      : 'bg-purple-500')
                  } />

                  {/* 結局類型徽章 */}
                  <div className="flex justify-center mb-4">
                    <span className={
                      'inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs tracking-widest ' +
                      (endingMeta.endingType === '好結局'
                        ? 'bg-emerald-900/50 text-emerald-300 border border-emerald-700'
                        : endingMeta.endingType === '壞結局'
                        ? 'bg-red-900/50 text-red-300 border border-red-700'
                        : 'bg-purple-900/50 text-purple-300 border border-purple-700')
                    }>
                      {endingMeta.endingType}
                    </span>
                  </div>

                  {/* 劇名 */}
                  <h2 className="text-3xl md:text-4xl font-serif font-bold mb-2">
                    {endingMeta.title}
                  </h2>

                  {/* 開場 */}
                  {openingText && (
                    <div className="mt-6 text-left">
                      <p className="text-xs text-zinc-600 tracking-widest mb-1">開場</p>
                      <p className="text-sm text-zinc-400 italic line-clamp-3">
                        {openingText}
                      </p>
                    </div>
                  )}

                  {/* 結局 */}
                  {endingText && (
                    <div className="mt-4 text-left">
                      <p className="text-xs text-zinc-600 tracking-widest mb-1">結局</p>
                      <p className="text-sm text-zinc-300 line-clamp-3">
                        {endingText}
                      </p>
                    </div>
                  )}

                  {/* AI 判詞 */}
                  <div className="mt-6 pt-6 border-t border-zinc-800">
                    <p className="text-xs text-zinc-600 tracking-widest mb-2">AI 判詞</p>
                    <p className="text-lg font-serif italic text-amber-200">
                      「{endingMeta.verdict}」
                    </p>
                  </div>

                  {/* 水印 */}
                  <p className="mt-6 text-[10px] text-zinc-700 tracking-widest">
                    人生盲盒 · LIFE BLIND BOX
                  </p>
                </div>

                {/* 分享按鈕 */}
                <div className="flex flex-wrap justify-center gap-2 mt-4">
                  <button
                    onClick={handleShareNative}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white text-black text-sm font-medium hover:bg-zinc-200 transition-all"
                  >
                    <Share2 size={14} />
                    分享
                  </button>
                  <button
                    onClick={handleShareTwitter}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-900 border border-zinc-700 text-zinc-300 text-sm hover:bg-zinc-800 transition-all"
                  >
                    <Twitter size={14} />
                    發到 X
                  </button>
                  <button
                    onClick={handleShareCopy}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-900 border border-zinc-700 text-zinc-300 text-sm hover:bg-zinc-800 transition-all"
                  >
                    <Copy size={14} />
                    {copied ? '已複製 ✓' : '複製文字'}
                  </button>
                </div>
              </div>
            ) : (
              <h2 className="text-4xl md:text-5xl font-serif">故事結束</h2>
            )}

            {/* 完整對話紀錄（折疊） */}
            <details className="max-w-xl mx-auto text-sm">
              <summary className="text-zinc-500 cursor-pointer hover:text-zinc-300 transition-colors">
                查看完整對話紀錄（{subtitles.length}）
              </summary>
              <div className="mt-4 space-y-3 max-h-64 overflow-y-auto text-left pr-2">
                {subtitles.map((s, i) => (
                  <div key={i} className={`text-sm leading-relaxed ${s.role === 'user' ? 'text-amber-300/80' : 'text-zinc-300'}`}>
                    <span className="text-xs text-zinc-600 mr-2">
                      {s.role === 'user' ? '你' : '旁白'}
                    </span>
                    {s.text}
                  </div>
                ))}
              </div>
            </details>

            {/* 再開一盒 */}
            {remainingToday > 0 ? (
              <button
                onClick={() => {
                  socketRef.current?.emit('replay_clicked', {
                    turnId: currentTurnIdRef.current,
                    generationId: currentGenerationIdRef.current,
                  })
                  resetGame()
                  setTimeout(() => startGame(), 300)
                }}
                disabled={remainingToday === 0}
                className="mt-4 inline-flex items-center gap-2 px-6 py-3 rounded-full bg-white text-black font-medium tracking-wider hover:bg-zinc-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <RefreshCw size={16} />
                再開一盒（{remainingToday} 局剩餘）
              </button>
            ) : (
              <div className="mt-4 space-y-2">
                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-500 text-sm">
                  <Lock size={14} />
                  今日額度已用完，明天再來
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Footer: Push-to-talk button */}
      {phase !== 'ended' && (
        <footer className="w-full max-w-3xl flex flex-col items-center gap-3 relative z-10 pb-4">
          <button
            onPointerDown={(e) => {
              e.preventDefault()
              if (canRecord && phase !== 'narrating') {
                startRecording()
              } else if (canRecord && phase === 'narrating') {
                // 允許在旁白時搶話
                startRecording()
              }
            }}
            onPointerUp={(e) => {
              e.preventDefault()
              if (phase === 'recording') {
                stopRecording()
              }
            }}
            onPointerLeave={(e) => {
              e.preventDefault()
              if (phase === 'recording') {
                stopRecording()
              }
            }}
            disabled={!canRecord}
            className={`relative w-32 h-32 rounded-full flex items-center justify-center transition-all duration-200 select-none touch-none ${
              phase === 'recording'
                ? 'bg-red-600 scale-110 shadow-[0_0_60px_rgba(220,38,38,0.5)]'
                : isPlaying
                ? 'bg-amber-700/60 scale-105'
                : canRecord
                ? 'bg-zinc-800 hover:bg-zinc-700 ring-1 ring-zinc-700'
                : 'bg-zinc-900 opacity-50 cursor-not-allowed'
            }`}
            aria-label="push to talk"
          >
            {/* Pulse ring while recording */}
            {phase === 'recording' && (
              <span className="absolute inset-0 rounded-full bg-red-600 animate-ping opacity-30" />
            )}
            {/* Pulse ring while AI playing */}
            {isPlaying && phase !== 'recording' && (
              <span className="absolute inset-0 rounded-full bg-amber-500/40 animate-pulse" />
            )}
            {phase === 'recording' ? (
              <Square size={36} className="text-white relative z-10" fill="currentColor" />
            ) : phase === 'transcribing' ? (
              <Loader2 size={36} className="text-zinc-300 animate-spin relative z-10" />
            ) : (
              <Mic size={36} className="text-zinc-300 relative z-10" />
            )}
          </button>
          <p className="text-xs text-zinc-500 tracking-widest text-center">
            {phase === 'recording' ? '鬆手送出' :
             isPlaying ? 'AI 說話中 · 按住可搶話' :
             phase === 'transcribing' ? '理解中...' :
             phase === 'narrating' ? '旁白中 · 按住可搶話' :
             canRecord ? '按住說話' :
             '等待連線...'}
          </p>
          {subtitles.length > 0 && phase !== 'narrating' && phase !== 'transcribing' && (
            <button
              onClick={resetGame}
              className="mt-2 text-xs text-zinc-500 hover:text-zinc-300 tracking-widest transition-colors inline-flex items-center gap-1"
            >
              <RefreshCw size={12} />
              重置遊戲
            </button>
          )}
        </footer>
      )}
    </div>
  )
}
