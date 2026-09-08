/**
 * Nexus Dash — a controller-first 3-lane dodge game, ported from the game
 * that used to ship inside core Nexus itself (removed when Arcade moved to
 * the plugin model — see the app's own project notes). Canvas-rendered, no
 * framework dependency, so it needed no build step to become a standalone
 * plugin bundle.
 *
 * PROVISIONAL PLUGIN CONTRACT — Nexus's real plugin loader/SDK doesn't
 * exist yet, so this is a best-guess shape, not a finalized API. It WILL
 * change once that's actually designed. For now:
 *
 *   window.ClashPointPlugin = {
 *     mount(container, api) -> void
 *       container: an HTMLElement this plugin owns exclusively while mounted
 *       api.onNav(handler): (action: NavAction) => void, returns an
 *         unsubscribe function. NavAction is one of the same normalized
 *         strings the host app's own nav bus uses: 'up' | 'down' | 'left' |
 *         'right' | 'confirm' | 'back' | 'menu'.
 *       api.exit(): call when the user has backed all the way out and the
 *         host should unmount/return focus to wherever launched this.
 *     unmount() -> void
 *       Stop all timers/animation frames/listeners. Called by the host
 *       whenever this plugin is being torn down, not just on exit().
 *   }
 *
 * This file also runs standalone (see preview.html) via a tiny local shim
 * that maps arrow keys/Enter/Escape to the same NavAction strings, so it's
 * fully playable and testable in a plain browser right now, before any of
 * the real host-loader machinery exists.
 */
;(function () {
  const LANE_COUNT = 3
  const BASE_SPEED = 260 // px/sec
  const MAX_SPEED = 620
  const ACCEL_PER_SEC = 6 // speed gained per second survived
  const SPAWN_INTERVAL_START_MS = 950
  const SPAWN_INTERVAL_MIN_MS = 420
  const COIN_CHANCE = 0.28
  const PLAYER_Y_FRACTION = 0.82
  const COUNTDOWN_MS = 1200
  // Matches the actual shapes drawn below — the ship's triangle spans
  // playerY-24 to playerY+18 vertically and playerX+/-20 horizontally; the
  // rock diamond and coin circle are both roughly +/-16px from their
  // center. Collision uses these directly (real bounding-box overlap
  // against the ship's actual rendered X, not just "same lane") rather
  // than a coarse same-lane + Y-proximity check, which could register a
  // hit against the destination lane before the ship's sprite had
  // actually eased into it — death while still mid-lane-switch, never
  // having visually touched anything.
  const SHIP_HALF_WIDTH = 20
  const SHIP_TOP_OFFSET = 24
  const SHIP_BOTTOM_OFFSET = 18
  const OBSTACLE_HALF_SIZE = 16
  const MAX_HIGH_SCORES_SHOWN = 5
  const HIGH_SCORE_STORAGE_KEY = 'clashpoint-plugin-nexus-dash-highscores'

  function shipOverlaps(shipX, playerY, obsX, obsY) {
    const shipLeft = shipX - SHIP_HALF_WIDTH
    const shipRight = shipX + SHIP_HALF_WIDTH
    const shipTop = playerY - SHIP_TOP_OFFSET
    const shipBottom = playerY + SHIP_BOTTOM_OFFSET
    const obsLeft = obsX - OBSTACLE_HALF_SIZE
    const obsRight = obsX + OBSTACLE_HALF_SIZE
    const obsTop = obsY - OBSTACLE_HALF_SIZE
    const obsBottom = obsY + OBSTACLE_HALF_SIZE
    return shipLeft < obsRight && shipRight > obsLeft && shipTop < obsBottom && shipBottom > obsTop
  }

  function themeColor(varName, fallback) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
    return raw ? `rgb(${raw})` : fallback
  }

  function freshGameState() {
    return {
      lane: 1,
      playerX: 0,
      obstacles: [],
      elapsedMs: 0,
      speed: BASE_SPEED,
      spawnTimerMs: 0,
      score: 0,
      laneSwitchQueued: 0
    }
  }

  // No real per-plugin storage API exists yet either (see the contract
  // note above) — plain localStorage, namespaced by this plugin's own key,
  // is the honest v1: works identically whether this is opened standalone
  // (preview.html) or eventually mounted inside the host app's own
  // renderer origin. A future real storage API can replace this without
  // changing anything else about how the game itself works.
  function loadHighScores() {
    try {
      const raw = localStorage.getItem(HIGH_SCORE_STORAGE_KEY)
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed.filter((n) => typeof n === 'number') : []
    } catch {
      return []
    }
  }

  function saveHighScore(score) {
    const scores = loadHighScores()
    scores.push(score)
    scores.sort((a, b) => b - a)
    const top = scores.slice(0, 10)
    try {
      localStorage.setItem(HIGH_SCORE_STORAGE_KEY, JSON.stringify(top))
    } catch {
      // Storage unavailable (private browsing, quota) — the run's own score
      // still shows on the game-over screen either way, just won't persist.
    }
    return top
  }

  function createGame(container, api) {
    let phase = 'ready' // ready | countdown | playing | paused | gameover
    let game = freshGameState()
    let score = 0
    let highScores = loadHighScores()
    let lastResult = null
    let rafId = null
    let countdownTimer = null
    let unsubscribeNav = null

    container.innerHTML = ''
    container.style.position = 'relative'
    container.style.width = '100%'
    container.style.height = '100%'
    container.style.overflow = 'hidden'
    container.style.background = themeColor('--color-bg', '#0b0b0f')
    container.style.color = 'white'
    container.style.fontFamily = 'Segoe UI, system-ui, sans-serif'

    const canvas = document.createElement('canvas')
    canvas.style.position = 'absolute'
    canvas.style.inset = '0'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    container.appendChild(canvas)

    const overlay = document.createElement('div')
    overlay.style.position = 'absolute'
    overlay.style.inset = '0'
    container.appendChild(overlay)

    const hud = document.createElement('div')
    hud.style.position = 'absolute'
    hud.style.left = '32px'
    hud.style.top = '32px'
    hud.style.display = 'none'
    hud.style.flexDirection = 'column'
    hud.innerHTML =
      '<span style="font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.7">Score</span>' +
      '<span id="cpd-score" style="font-size:36px;font-weight:700;font-variant-numeric:tabular-nums">0</span>'
    container.appendChild(hud)
    const scoreEl = hud.querySelector('#cpd-score')

    function resizeCanvas() {
      const rect = container.getBoundingClientRect()
      canvas.width = Math.max(1, Math.round(rect.width))
      canvas.height = Math.max(1, Math.round(rect.height))
    }
    resizeCanvas()
    const resizeObserver = new ResizeObserver(resizeCanvas)
    resizeObserver.observe(container)

    function panel(html) {
      overlay.innerHTML =
        '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7)">' +
        '<div style="display:flex;width:384px;flex-direction:column;align-items:center;gap:20px;border-radius:20px;background:' +
        themeColor('--color-surface', '#15151f') +
        ';padding:32px;text-align:center">' +
        html +
        '</div></div>'
    }

    function highScoreListHtml(highlightIndex) {
      if (highScores.length === 0) return ''
      const top = highScores.slice(0, MAX_HIGH_SCORES_SHOWN)
      const rows = top
        .map((s, i) => {
          const bold = i === highlightIndex
          return (
            '<div style="display:flex;justify-content:space-between;gap:24px;' +
            (bold ? `font-weight:700;color:${themeColor('--color-accent', '#5b8cff')}` : '') +
            '"><span>' +
            (i + 1) +
            '.</span><span style="font-variant-numeric:tabular-nums;font-weight:600">' +
            s +
            '</span></div>'
          )
        })
        .join('')
      return (
        '<div style="display:flex;width:100%;flex-direction:column;gap:4px;border-top:1px solid rgba(255,255,255,0.08);padding-top:16px;font-size:14px">' +
        '<span style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;opacity:0.7">Top Scores</span>' +
        rows +
        '</div>'
      )
    }

    function accentButton(label) {
      return (
        '<button data-action="primary" style="width:100%;border:none;cursor:pointer;border-radius:9999px;background:linear-gradient(135deg,' +
        themeColor('--color-accent', '#5b8cff') +
        ',' +
        themeColor('--color-accent-2', '#a06bff') +
        ');padding:12px 24px;font-size:18px;font-weight:600;color:white">' +
        label +
        '</button>'
      )
    }

    function quietButton(label, action) {
      return (
        '<button data-action="' +
        action +
        '" style="width:100%;border:none;cursor:pointer;border-radius:9999px;background:' +
        themeColor('--color-surface-hi', '#1e1e2c') +
        ';padding:12px 24px;font-size:14px;font-weight:500;color:inherit;opacity:0.8">' +
        label +
        '</button>'
      )
    }

    function showReady() {
      phase = 'ready'
      hud.style.display = 'none'
      panel(
        '<h1 style="margin:0;font-size:30px;font-weight:700;background:linear-gradient(135deg,' +
          themeColor('--color-accent', '#5b8cff') +
          ',' +
          themeColor('--color-accent-2', '#a06bff') +
          ');-webkit-background-clip:text;background-clip:text;color:transparent">Nexus Dash</h1>' +
          '<p style="margin:0;font-size:14px;opacity:0.7">Left/Right or D-Pad to dodge · Collect coins · Avoid rocks</p>' +
          highScoreListHtml(null) +
          accentButton('Start') +
          '<p style="margin:0;font-size:12px;opacity:0.6">Confirm to Start</p>'
      )
      overlay.querySelector('[data-action="primary"]').onclick = startGame
    }

    function startGame() {
      phase = 'countdown'
      game = freshGameState()
      score = 0
      hud.style.display = 'none'
      panel('<span style="font-size:30px;font-weight:700">Get Ready...</span>')
      clearTimeout(countdownTimer)
      countdownTimer = setTimeout(() => {
        phase = 'playing'
        overlay.innerHTML = ''
        hud.style.display = 'flex'
        runLoop()
      }, COUNTDOWN_MS)
    }

    function showPaused() {
      phase = 'paused'
      cancelAnimationFrame(rafId)
      panel(
        '<h2 style="margin:0;font-size:22px;font-weight:700">Paused</h2>' +
          accentButton('Resume') +
          quietButton('Quit', 'quit') +
          '<p style="margin:0;font-size:11px;opacity:0.6">Confirm: Resume · Back: Quit</p>'
      )
      overlay.querySelector('[data-action="primary"]').onclick = resumeGame
      overlay.querySelector('[data-action="quit"]').onclick = () => api.exit()
    }

    function resumeGame() {
      phase = 'playing'
      overlay.innerHTML = ''
      runLoop()
    }

    function endGame(finalScore) {
      phase = 'gameover'
      hud.style.display = 'none'
      const isNewHighScore = highScores.length < 10 || finalScore > (highScores[highScores.length - 1] ?? 0)
      highScores = saveHighScore(finalScore)
      const rank = highScores.indexOf(finalScore)
      lastResult = { score: finalScore, rank: isNewHighScore ? rank : null }
      panel(
        '<h2 style="margin:0;font-size:22px;font-weight:700">Game Over</h2>' +
          '<p style="margin:0;font-size:36px;font-weight:700;font-variant-numeric:tabular-nums">' +
          finalScore +
          '</p>' +
          (lastResult.rank != null
            ? '<p style="margin:0;font-weight:700;color:' +
              themeColor('--color-accent', '#5b8cff') +
              '">New High Score — #' +
              (lastResult.rank + 1) +
              '!</p>'
            : '') +
          highScoreListHtml(lastResult.rank) +
          accentButton('Play Again') +
          quietButton('Quit', 'quit') +
          '<p style="margin:0;font-size:11px;opacity:0.6">Confirm: Play Again · Back: Quit</p>'
      )
      overlay.querySelector('[data-action="primary"]').onclick = startGame
      overlay.querySelector('[data-action="quit"]').onclick = () => api.exit()
    }

    function runLoop() {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const colors = {
        bg: themeColor('--color-surface', '#15151f'),
        lane: themeColor('--color-surface-hi', '#1e1e2c'),
        accent: themeColor('--color-accent', '#5b8cff')
      }
      let lastTime = performance.now()

      function tick(time) {
        const dt = Math.min(0.05, (time - lastTime) / 1000)
        lastTime = time

        game.elapsedMs += dt * 1000
        game.speed = Math.min(MAX_SPEED, BASE_SPEED + (game.elapsedMs / 1000) * ACCEL_PER_SEC)

        if (game.laneSwitchQueued !== 0) {
          game.lane = Math.max(0, Math.min(LANE_COUNT - 1, game.lane + game.laneSwitchQueued))
          game.laneSwitchQueued = 0
        }

        const laneWidth = canvas.width / LANE_COUNT
        const targetX = laneWidth * (game.lane + 0.5)
        if (game.playerX === 0) game.playerX = targetX
        game.playerX += (targetX - game.playerX) * Math.min(1, dt * 10)

        const spawnInterval = Math.max(SPAWN_INTERVAL_MIN_MS, SPAWN_INTERVAL_START_MS - game.elapsedMs / 40)
        game.spawnTimerMs += dt * 1000
        if (game.spawnTimerMs >= spawnInterval) {
          game.spawnTimerMs = 0
          game.obstacles.push({
            lane: Math.floor(Math.random() * LANE_COUNT),
            y: -40,
            kind: Math.random() < COIN_CHANCE ? 'coin' : 'obstacle',
            resolved: false
          })
        }

        const playerY = canvas.height * PLAYER_Y_FRACTION
        let gameOver = false
        let coinsCollected = 0
        const stillObstacles = []
        for (const obs of game.obstacles) {
          obs.y += game.speed * dt
          const obsX = laneWidth * (obs.lane + 0.5)
          if (!obs.resolved && shipOverlaps(game.playerX, playerY, obsX, obs.y)) {
            obs.resolved = true
            if (obs.kind === 'coin') {
              coinsCollected += 1
              continue
            }
            gameOver = true
          }
          if (obs.y < canvas.height + 60) stillObstacles.push(obs)
        }
        game.obstacles = stillObstacles

        if (coinsCollected > 0) game.score += coinsCollected * 50
        game.score += dt * (game.speed / 12)
        score = Math.floor(game.score)
        scoreEl.textContent = String(score)

        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.fillStyle = colors.bg
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.strokeStyle = colors.lane
        ctx.lineWidth = 2
        for (let i = 1; i < LANE_COUNT; i++) {
          const x = laneWidth * i
          ctx.beginPath()
          ctx.moveTo(x, 0)
          ctx.lineTo(x, canvas.height)
          ctx.stroke()
        }

        for (const obs of game.obstacles) {
          const x = laneWidth * (obs.lane + 0.5)
          if (obs.kind === 'coin') {
            ctx.beginPath()
            ctx.arc(x, obs.y, 15, 0, Math.PI * 2)
            ctx.fillStyle = '#facc15'
            ctx.fill()
            ctx.lineWidth = 2
            ctx.strokeStyle = '#ca8a04'
            ctx.stroke()
          } else {
            const size = 32
            ctx.fillStyle = '#78716c'
            ctx.beginPath()
            ctx.moveTo(x, obs.y - size / 2)
            ctx.lineTo(x + size / 2, obs.y)
            ctx.lineTo(x, obs.y + size / 2)
            ctx.lineTo(x - size / 2, obs.y)
            ctx.closePath()
            ctx.fill()
          }
        }

        ctx.fillStyle = colors.accent
        ctx.beginPath()
        ctx.moveTo(game.playerX, playerY - 24)
        ctx.lineTo(game.playerX + 20, playerY + 18)
        ctx.lineTo(game.playerX, playerY + 8)
        ctx.lineTo(game.playerX - 20, playerY + 18)
        ctx.closePath()
        ctx.fill()

        if (gameOver) {
          endGame(Math.floor(game.score))
          return
        }
        rafId = requestAnimationFrame(tick)
      }

      rafId = requestAnimationFrame(tick)
    }

    function handleNav(action) {
      if (phase === 'playing') {
        if (action === 'left') game.laneSwitchQueued = -1
        else if (action === 'right') game.laneSwitchQueued = 1
        else if (action === 'back' || action === 'menu') showPaused()
        return
      }
      if (phase === 'paused') {
        if (action === 'confirm') resumeGame()
        else if (action === 'back' || action === 'menu') api.exit()
        return
      }
      if (phase === 'ready' || phase === 'gameover') {
        if (action === 'confirm') startGame()
        else if (action === 'back' || action === 'menu') api.exit()
      }
      // 'countdown' ignores input entirely, same as the original.
    }

    unsubscribeNav = api.onNav(handleNav)
    showReady()

    return {
      destroy() {
        cancelAnimationFrame(rafId)
        clearTimeout(countdownTimer)
        resizeObserver.disconnect()
        if (unsubscribeNav) unsubscribeNav()
        container.innerHTML = ''
      }
    }
  }

  let activeInstance = null

  window.ClashPointPlugin = {
    id: 'nexus-dash',
    mount(container, api) {
      activeInstance = createGame(container, api)
    },
    unmount() {
      if (activeInstance) activeInstance.destroy()
      activeInstance = null
    }
  }
})()
