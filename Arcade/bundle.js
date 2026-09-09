(function () {
  // ---------------------------------------------------------------------
  // System table — the one piece of data a later system just extends.
  // Core filenames are libretro's own documented naming convention
  // (https://github.com/libretro/libretro-core-info), one per system,
  // installed separately from RetroArch via its own Core Downloader —
  // this never installs anything, only ever checks whether a core file
  // is already sitting where RetroArch expects it.
  // ---------------------------------------------------------------------
  var SYSTEMS = [
    { id: 'nes', name: 'NES', extensions: ['.nes'], core: 'nestopia_libretro.dll' },
    { id: 'snes', name: 'SNES', extensions: ['.sfc', '.smc'], core: 'snes9x_libretro.dll' },
    { id: 'genesis', name: 'Genesis', extensions: ['.md', '.gen', '.bin'], core: 'genesis_plus_gx_libretro.dll' },
    { id: 'n64', name: 'N64', extensions: ['.n64', '.z64'], core: 'mupen64plus_libretro.dll' },
    { id: 'gba', name: 'GBA', extensions: ['.gba'], core: 'mgba_libretro.dll' }
  ]

  // Canonical extraction path RetroArch's own Windows download instructions
  // recommend for the portable build, plus the default Steam library
  // location for the Steam release (App ID 1118310) — checked directly
  // rather than guessed from an env var this sandbox has no primitive to
  // read. If neither is right, the RetroArch row's own "change" action
  // covers it.
  var RETROARCH_CANDIDATE_DIRS = ['C:\\RetroArch-Win64', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\RetroArch']

  var STORAGE_KEY = 'arcade.config.v1'

  function loadConfig() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : { folders: {}, retroArchDir: null }
    } catch (e) {
      return { folders: {}, retroArchDir: null }
    }
  }

  function saveConfig(config) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
    } catch (e) {
      // Config is a convenience cache, not the source of truth for
      // anything critical — a failed write just means re-detecting next
      // launch, never a reason to interrupt the user.
    }
  }

  // Every listDir call goes through this — never swallow the real reason
  // a folder read failed. A generic "doesn't exist" guess is actively
  // misleading when the real cause is something else (permissions, a
  // trailing-slash mismatch, anything) — whatever Node actually says is
  // always more honest than a guess, and it's the only thing that makes a
  // bug report about this useful at all.
  async function safeListDir(path) {
    try {
      var entries = await api.listDir(path)
      return { entries: entries, error: null }
    } catch (e) {
      return { entries: null, error: e && e.message ? e.message : String(e) }
    }
  }

  // ---------------------------------------------------------------------
  // RetroArch adapter — one plain object, not a class. A second,
  // structurally different emulator later is a second object implementing
  // the same methods its own way, not a subclass of this one.
  // ---------------------------------------------------------------------
  var RetroArchAdapter = {
    // -> { dir, error }. dir is null if not found; error carries the real
    // reason from the last attempt, for display, not just a guess.
    detect: async function (config) {
      if (config.retroArchDir) {
        var cached = await this._hasExe(config.retroArchDir)
        if (cached.found) return { dir: config.retroArchDir, error: null }
      }
      var lastError = null
      for (var i = 0; i < RETROARCH_CANDIDATE_DIRS.length; i++) {
        var dir = RETROARCH_CANDIDATE_DIRS[i]
        var result = await this._hasExe(dir)
        if (result.found) return { dir: dir, error: null }
        if (result.error) lastError = result.error
      }
      return { dir: null, error: lastError }
    },

    // -> { found, error }.
    _hasExe: async function (dir) {
      var result = await safeListDir(dir)
      if (result.entries === null) return { found: false, error: result.error }
      return { found: result.entries.indexOf('retroarch.exe') !== -1, error: null }
    },

    // -> { path, error }. Standard portable-layout convention: cores live
    // in a `cores` folder alongside retroarch.exe itself.
    findCore: async function (retroArchDir, coreFilename) {
      var result = await safeListDir(retroArchDir + '\\cores')
      if (result.entries === null) return { path: null, error: result.error }
      var found = result.entries.indexOf(coreFilename) !== -1
      return { path: found ? retroArchDir + '\\cores\\' + coreFilename : null, error: null }
    },

    // -> { roms, error }. roms is an array of { name, path }, filtered by
    // this system's extensions.
    listRoms: async function (folderPath, extensions) {
      var result = await safeListDir(folderPath)
      if (result.entries === null) return { roms: null, error: result.error }
      var roms = []
      for (var i = 0; i < result.entries.length; i++) {
        var name = result.entries[i]
        var dot = name.lastIndexOf('.')
        if (dot === -1) continue
        var ext = name.slice(dot).toLowerCase()
        if (extensions.indexOf(ext) === -1) continue
        roms.push({ name: name.slice(0, dot), path: folderPath + '\\' + name })
      }
      roms.sort(function (a, b) {
        return a.name.localeCompare(b.name)
      })
      return { roms: roms, error: null }
    },

    buildLaunchArgs: function (corePath, romPath) {
      return ['-L', corePath, romPath, '--fullscreen']
    },

    launch: function (retroArchDir, corePath, romPath) {
      return api.spawnProcess(retroArchDir + '\\retroarch.exe', this.buildLaunchArgs(corePath, romPath))
    }
  }

  // ---------------------------------------------------------------------
  // Tiny DOM helper — same shape as the Phase 1 diagnostic stub, no
  // framework available inside the sandbox.
  // ---------------------------------------------------------------------
  function h(tag, props, children) {
    var el = document.createElement(tag)
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'style') Object.assign(el.style, props[k])
        else el[k] = props[k]
      })
    }
    ;(children || []).forEach(function (c) {
      if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    })
    return el
  }

  var COLORS = {
    bg: '#0b0b0f',
    panel: '#151519',
    accent: '#4338ca',
    muted: '#8f8fa3'
  }

  function mount(root, api) {
    // ---- state ----
    var config = loadConfig()
    var zone = 'systems' // 'systems' | 'games'
    var topIndex = 0 // index into getTopRows() — the 5 systems + the RetroArch row
    var gameIndex = 0 // index into getGameRows() — the "Change Folder" row + games
    var games = [] // currently-shown ROM list for the selected system
    var statusMessage = ''
    var retroArchDir = null
    var detecting = true
    // Which top-row (system) the current game list belongs to — separate
    // from topIndex so leaving/re-entering the systems list doesn't lose
    // which system's games are on screen.
    var currentSystemTopIndex = 0

    root.style.cssText =
      'background:' +
      COLORS.bg +
      ';color:#fff;font-family:sans-serif;height:100%;display:flex;flex-direction:column;' +
      'padding:32px;box-sizing:border-box;gap:16px;overflow:hidden'

    function getTopRows() {
      var rows = SYSTEMS.map(function (s) {
        return { kind: 'system', system: s }
      })
      rows.push({ kind: 'retroarch' })
      return rows
    }

    function getGameRows() {
      var rows = [{ kind: 'changeFolder' }]
      games.forEach(function (g) {
        rows.push({ kind: 'game', game: g })
      })
      return rows
    }

    async function detectRetroArch() {
      detecting = true
      render()
      var result = await RetroArchAdapter.detect(config)
      retroArchDir = result.dir
      if (retroArchDir && retroArchDir !== config.retroArchDir) {
        config.retroArchDir = retroArchDir
        saveConfig(config)
      }
      statusMessage = retroArchDir
        ? ''
        : result.error
          ? "Couldn't find RetroArch automatically (" + result.error + ')'
          : "Couldn't find RetroArch automatically"
      detecting = false
      render()
    }

    // Always reachable, whether RetroArch is already found or not — a
    // wrong or stale detection needs a way back, not just a first-run
    // fallback.
    async function changeRetroArchFolder() {
      var folder = await api.pickFolder()
      if (!folder) return
      var result = await RetroArchAdapter._hasExe(folder)
      if (!result.found) {
        statusMessage = result.error
          ? "That folder doesn't have retroarch.exe in it (" + result.error + ')'
          : "That folder doesn't have retroarch.exe in it"
        render()
        return
      }
      retroArchDir = folder
      config.retroArchDir = folder
      saveConfig(config)
      statusMessage = 'Found RetroArch at ' + folder
      render()
    }

    // Also always reachable — assigning once and being stuck with it
    // (wrong folder, moved folder) was the other real problem here.
    async function assignFolder(system) {
      var folder = await api.pickFolder()
      if (!folder) return
      config.folders[system.id] = folder
      saveConfig(config)
      statusMessage = 'Folder set for ' + system.name
      render()
    }

    async function openSystem(system) {
      var folder = config.folders[system.id]
      if (!folder) {
        await assignFolder(system)
        return
      }
      statusMessage = 'Scanning ' + system.name + ' folder...'
      render()
      var result = await RetroArchAdapter.listRoms(folder, system.extensions)
      if (result.roms === null) {
        statusMessage = "Couldn't read " + folder + (result.error ? ' (' + result.error + ')' : '')
        render()
        return
      }
      games = result.roms
      gameIndex = 0
      zone = 'games'
      statusMessage = ''
      render()
    }

    async function launchGame(system, game) {
      if (!retroArchDir) {
        statusMessage = 'RetroArch not found — see above'
        render()
        return
      }
      var core = await RetroArchAdapter.findCore(retroArchDir, system.core)
      if (!core.path) {
        statusMessage = core.error
          ? "Couldn't check for the " + system.core + ' core (' + core.error + ')'
          : system.name + " needs the " + system.core + " core, not installed. Get it from RetroArch's own Core Downloader."
        render()
        return
      }
      statusMessage = 'Launching ' + game.name + '...'
      render()
      var result = await RetroArchAdapter.launch(retroArchDir, core.path, game.path)
      if (result && result.error) {
        statusMessage = 'Launch failed: ' + result.error
        render()
      }
    }

    function render() {
      root.innerHTML = ''

      var header = h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '12px' } }, [
        h('h1', { style: { fontSize: '26px', margin: '0' } }, ['Arcade']),
        h('span', { style: { color: COLORS.muted, fontSize: '13px' } }, [
          detecting ? 'Looking for RetroArch...' : retroArchDir ? 'RetroArch: ' + retroArchDir : 'RetroArch not found'
        ])
      ])
      root.appendChild(header)

      if (zone === 'systems') root.appendChild(renderSystems())
      else root.appendChild(renderGamesForCurrentSystem())

      if (statusMessage) {
        root.appendChild(h('p', { style: { color: COLORS.muted, fontSize: '13px', margin: '0' } }, [statusMessage]))
      }
    }

    function renderSystems() {
      var rows = getTopRows()
      var list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto' } })
      rows.forEach(function (row, i) {
        var focused = i === topIndex
        if (row.kind === 'retroarch') {
          list.appendChild(
            h(
              'div',
              {
                onclick: function () {
                  topIndex = i
                  changeRetroArchFolder()
                },
                style: {
                  background: focused ? COLORS.accent : COLORS.panel,
                  borderRadius: '10px',
                  padding: '14px 18px',
                  cursor: 'pointer',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginTop: '8px'
                }
              },
              [
                h('span', { style: { fontWeight: '600' } }, ['RetroArch']),
                h('span', { style: { fontSize: '12px', color: focused ? '#e0e0ff' : COLORS.muted } }, [
                  retroArchDir ? retroArchDir + ' — press Confirm to change' : 'Not found — press Confirm to locate it'
                ])
              ]
            )
          )
          return
        }
        var system = row.system
        var folder = config.folders[system.id]
        list.appendChild(
          h(
            'div',
            {
              onclick: function () {
                topIndex = i
                currentSystemTopIndex = i
                openSystem(system)
              },
              style: {
                background: focused ? COLORS.accent : COLORS.panel,
                borderRadius: '10px',
                padding: '14px 18px',
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }
            },
            [
              h('span', { style: { fontWeight: '600' } }, [system.name]),
              h('span', { style: { fontSize: '12px', color: focused ? '#e0e0ff' : COLORS.muted } }, [
                folder ? folder : 'Not set up — press Confirm to pick a folder'
              ])
            ]
          )
        )
      })
      return list
    }

    function currentSystem() {
      return SYSTEMS[currentSystemTopIndex]
    }

    function renderGamesForCurrentSystem() {
      var system = currentSystem()
      var rows = getGameRows()
      var wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', overflow: 'hidden', flex: '1' } })
      wrap.appendChild(
        h('h2', { style: { fontSize: '16px', margin: '0 0 4px 0', color: COLORS.muted } }, [
          system.name + ' — ' + games.length + ' found'
        ])
      )
      var list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', overflowY: 'auto' } })
      rows.forEach(function (row, i) {
        var focused = i === gameIndex
        if (row.kind === 'changeFolder') {
          list.appendChild(
            h(
              'div',
              {
                onclick: function () {
                  gameIndex = i
                  assignFolder(system)
                },
                style: {
                  background: focused ? COLORS.accent : 'transparent',
                  border: '1px dashed ' + (focused ? COLORS.accent : COLORS.muted),
                  borderRadius: '8px',
                  padding: '10px 16px',
                  cursor: 'pointer',
                  color: focused ? '#fff' : COLORS.muted,
                  fontSize: '13px'
                }
              },
              ['Change Folder (' + config.folders[system.id] + ')']
            )
          )
          return
        }
        var game = row.game
        list.appendChild(
          h(
            'div',
            {
              onclick: function () {
                gameIndex = i
                launchGame(system, game)
              },
              style: {
                background: focused ? COLORS.accent : COLORS.panel,
                borderRadius: '8px',
                padding: '10px 16px',
                cursor: 'pointer'
              }
            },
            [game.name]
          )
        )
      })
      if (games.length === 0) {
        list.appendChild(h('p', { style: { color: COLORS.muted, fontSize: '13px' } }, ['No matching ROM files in that folder.']))
      }
      wrap.appendChild(list)
      return wrap
    }

    // ---- nav ----
    api.onNav(function (action) {
      if (zone === 'systems') {
        var topRows = getTopRows()
        if (action === 'up') topIndex = Math.max(0, topIndex - 1)
        else if (action === 'down') topIndex = Math.min(topRows.length - 1, topIndex + 1)
        else if (action === 'confirm') {
          var row = topRows[topIndex]
          if (row.kind === 'retroarch') changeRetroArchFolder()
          else {
            currentSystemTopIndex = topIndex
            openSystem(row.system)
          }
        } else if (action === 'back' || action === 'menu') {
          api.exit()
          return
        } else return
        render()
        return
      }
      // zone === 'games'
      var gameRows = getGameRows()
      if (action === 'up') gameIndex = Math.max(0, gameIndex - 1)
      else if (action === 'down') gameIndex = Math.min(gameRows.length - 1, gameIndex + 1)
      else if (action === 'confirm') {
        var gRow = gameRows[gameIndex]
        if (gRow.kind === 'changeFolder') assignFolder(currentSystem())
        else launchGame(currentSystem(), gRow.game)
      } else if (action === 'back' || action === 'menu') {
        zone = 'systems'
        topIndex = currentSystemTopIndex
        statusMessage = ''
      } else return
      render()
    })

    render()
    detectRetroArch()
  }

  window.ClashPointPlugin = { mount: mount }
})()
