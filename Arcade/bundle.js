(function () {
  // Set once mount() actually runs (see the bottom of this file). Declared
  // up here, not just as mount's own parameter, because RetroArchAdapter/
  // safeListDir/candidateRetroArchDirs below all need it too and are
  // deliberately defined outside mount() itself (a real reusable object,
  // not a closure) — every call to api.* anywhere in this file resolves
  // to this one shared reference.
  var api

  // ---------------------------------------------------------------------
  // System table — the one piece of data a later system just extends.
  // Core filenames are libretro's own documented naming convention
  // (https://github.com/libretro/libretro-core-info), one per system,
  // installed separately from RetroArch via its own Core Downloader —
  // this never installs anything, only ever checks whether a core file
  // is already sitting where RetroArch expects it.
  // ---------------------------------------------------------------------
  var SYSTEMS = [
    // cores is only ever a *suggested default* — the first one found gets
    // auto-picked so most people never have to think about it, but it's
    // never the only option: RetroArch has multiple real cores per system
    // (accuracy vs. performance tradeoffs, different compatibility), and
    // the user can always override this from the games list's own
    // "Change Core" row, which lists every .dll actually in their cores
    // folder, not just these guesses. N64 shipped wrong here once already
    // for exactly the reason this list exists at all: RetroArch's Core
    // Downloader moved from the original Mupen64Plus core to
    // "Mupen64Plus-Next" a while back, and a single hardcoded name has no
    // way to survive that kind of rename on its own.
    { id: 'nes', name: 'NES', extensions: ['.nes'], cores: ['nestopia_libretro.dll', 'fceumm_libretro.dll'] },
    { id: 'snes', name: 'SNES', extensions: ['.sfc', '.smc'], cores: ['snes9x_libretro.dll'] },
    { id: 'genesis', name: 'Genesis', extensions: ['.md', '.gen', '.bin'], cores: ['genesis_plus_gx_libretro.dll'] },
    {
      id: 'n64',
      name: 'N64',
      extensions: ['.n64', '.z64'],
      cores: ['mupen64plus_next_libretro.dll', 'mupen64plus_libretro.dll']
    },
    { id: 'gba', name: 'GBA', extensions: ['.gba'], cores: ['mgba_libretro.dll'] },
    // mGBA is a genuine multi-system core, not GBA-only -- it has its own
    // "Game Boy model" autodetect covering GB/GBC/GBA from the same core,
    // so this reuses the exact same, already-verified core file as GBA
    // above rather than introducing a new one to get wrong.
    { id: 'gb', name: 'Game Boy / Color', extensions: ['.gb', '.gbc'], cores: ['mgba_libretro.dll', 'gambatte_libretro.dll'] },
    // Genesis Plus GX is also a real multi-system core (SG-1000/Master
    // System/Game Gear/Genesis/Mega CD, not just Genesis) -- same
    // already-verified core file as Genesis above, zero new core to
    // introduce or get wrong.
    { id: 'sms', name: 'Master System / Game Gear', extensions: ['.sms', '.gg'], cores: ['genesis_plus_gx_libretro.dll'] }
  ]

  // Fixed candidates: the canonical extraction path RetroArch's own
  // Windows download instructions recommend for the portable build, a
  // couple of common simplifications of it, and the default Steam library
  // location for the Steam release (App ID 1118310). Widened with
  // env-var-based guesses at detect time (see candidateRetroArchDirs) —
  // an installer's actual default varies by version/install method, and
  // no fixed list covers every one of them. If nothing here is right
  // either, the RetroArch row's own "change" action always works
  // regardless, since it just checks whatever folder you point it at.
  var RETROARCH_FIXED_CANDIDATE_DIRS = [
    'C:\\RetroArch-Win64',
    'C:\\RetroArch',
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\RetroArch'
  ]

  // getEnvVar only exists on Nexus v0.2.91+ (see main/plugins/pluginShell.ts)
  // — if this plugin ever gets reinstalled ahead of a core update, api
  // simply won't have it yet. Guarded rather than assumed, so this
  // degrades to the fixed candidate list instead of throwing.
  async function candidateRetroArchDirs() {
    var dirs = RETROARCH_FIXED_CANDIDATE_DIRS.slice()
    if (typeof api.getEnvVar !== 'function') return dirs
    var localAppData = await api.getEnvVar('LOCALAPPDATA')
    if (localAppData) {
      dirs.push(localAppData + '\\RetroArch-Win64')
      dirs.push(localAppData + '\\Programs\\RetroArch')
    }
    var programFiles = await api.getEnvVar('ProgramFiles')
    if (programFiles) dirs.push(programFiles + '\\RetroArch-Win64')
    return dirs
  }

  // Windows filesystems are case-insensitive but case-preserving —
  // readdir returns whatever casing is actually on disk, which won't
  // always match a lowercase guess like 'retroarch.exe' exactly (a
  // source-built RetroArch.exe, for instance). Matching case-insensitively
  // here is the safe default; actually launching the exe works either way
  // since Windows itself resolves paths case-insensitively.
  function findCaseInsensitive(entries, name) {
    var lower = name.toLowerCase()
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].toLowerCase() === lower) return true
    }
    return false
  }

  var STORAGE_KEY = 'arcade.config.v1'

  function loadConfig() {
    var config
    try {
      var raw = localStorage.getItem(STORAGE_KEY)
      config = raw ? JSON.parse(raw) : { folders: {}, retroArchDir: null }
    } catch (e) {
      config = { folders: {}, retroArchDir: null }
    }
    // cores: {} is new — an already-installed config from before this
    // existed won't have it, so this fills it in rather than assuming.
    if (!config.cores) config.cores = {}
    return config
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
      var candidates = await candidateRetroArchDirs()
      var lastError = null
      for (var i = 0; i < candidates.length; i++) {
        var dir = candidates[i]
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
      return { found: findCaseInsensitive(result.entries, 'retroarch.exe'), error: null }
    },

    // -> { path, filename, error }. Standard portable-layout convention:
    // cores live in a `cores` folder alongside retroarch.exe itself.
    // chosenFilename is the user's own explicit pick (config.cores[id]),
    // checked first and on its own — if they picked one and it's since
    // vanished, that's worth its own clear message, not a silent fallback
    // to something they didn't choose. Only when nothing's been chosen
    // yet does this fall back to fallbackCandidates (the SYSTEMS table's
    // suggested defaults), auto-picking the first one actually present.
    findCore: async function (retroArchDir, chosenFilename, fallbackCandidates) {
      var result = await safeListDir(retroArchDir + '\\cores')
      if (result.entries === null) return { path: null, filename: null, error: result.error }
      if (chosenFilename) {
        var stillThere = findCaseInsensitive(result.entries, chosenFilename)
        return stillThere
          ? { path: retroArchDir + '\\cores\\' + chosenFilename, filename: chosenFilename, error: null }
          : { path: null, filename: null, error: null }
      }
      for (var i = 0; i < fallbackCandidates.length; i++) {
        if (findCaseInsensitive(result.entries, fallbackCandidates[i])) {
          return { path: retroArchDir + '\\cores\\' + fallbackCandidates[i], filename: fallbackCandidates[i], error: null }
        }
      }
      return { path: null, filename: null, error: null }
    },

    // -> { cores, error }. Every .dll in the cores folder, not just the
    // ones this system happens to suggest — the whole point is letting
    // the user pick literally any core they have installed.
    listCores: async function (retroArchDir) {
      var result = await safeListDir(retroArchDir + '\\cores')
      if (result.entries === null) return { cores: null, error: result.error }
      var cores = result.entries.filter(function (name) {
        return name.slice(-4).toLowerCase() === '.dll'
      })
      cores.sort(function (a, b) {
        return a.localeCompare(b)
      })
      return { cores: cores, error: null }
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

  function mount(root, hostApi) {
    api = hostApi
    // ---- state ----
    var config = loadConfig()
    var zone = 'systems' // 'systems' | 'games' | 'selectCore'
    var topIndex = 0 // index into getTopRows() — SYSTEMS.length systems + the RetroArch row
    var gameIndex = 0 // index into getGameRows() — the "Change Folder"/"Change Core" rows + games
    var games = [] // currently-shown ROM list for the selected system
    var statusMessage = ''
    var retroArchDir = null
    var detecting = true
    // Which top-row (system) the current game list belongs to — separate
    // from topIndex so leaving/re-entering the systems list doesn't lose
    // which system's games are on screen.
    var currentSystemTopIndex = 0
    // The current system's resolved core (auto-detected or explicitly
    // chosen) — refreshed whenever its game list opens or its core
    // selection changes, not just at launch time, so "Change Core" and
    // the games list can both show what's actually active right now.
    var currentCoreFilename = null
    var coreStatusMessage = ''
    // 'selectCore' zone state
    var availableCores = []
    var coreIndex = 0

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
      var rows = [{ kind: 'changeFolder' }, { kind: 'changeCore' }]
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

    // Re-resolves what core a system would actually launch with right
    // now — the explicit pick in config.cores[id] if there is one, else
    // the first suggested default that's actually present. Called
    // whenever a system's game list opens or its core selection changes,
    // not just at launch time, so the games screen can show what's
    // active instead of only finding out when a launch fails.
    async function refreshCurrentCore(system) {
      if (!retroArchDir) {
        currentCoreFilename = null
        coreStatusMessage = ''
        return
      }
      var core = await RetroArchAdapter.findCore(retroArchDir, config.cores[system.id], system.cores)
      if (core.path) {
        currentCoreFilename = core.filename
        coreStatusMessage = ''
        // Remember whatever actually resolved, auto-detected or chosen,
        // so next time is instant and "Change Core" shows the real
        // current pick, not just a re-guess.
        if (config.cores[system.id] !== core.filename) {
          config.cores[system.id] = core.filename
          saveConfig(config)
        }
      } else {
        currentCoreFilename = null
        coreStatusMessage = core.error
          ? "Couldn't check for a core (" + core.error + ')'
          : config.cores[system.id]
            ? 'Your chosen core (' + config.cores[system.id] + ") isn't there anymore, pick another with Change Core"
            : system.name + ' needs one of: ' + system.cores.join(', ') + ", or pick your own with Change Core"
      }
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
      await refreshCurrentCore(system)
      render()
    }

    // Always reachable from the games list, not just when a core is
    // missing — real choice means picking a different core even when the
    // auto-detected one works fine, e.g. swapping accuracy for speed.
    async function changeCoreForSystem(system) {
      if (!retroArchDir) {
        statusMessage = 'RetroArch not found, see above'
        render()
        return
      }
      statusMessage = 'Looking for installed cores...'
      render()
      var result = await RetroArchAdapter.listCores(retroArchDir)
      if (result.cores === null) {
        statusMessage = "Couldn't read the cores folder" + (result.error ? ' (' + result.error + ')' : '')
        render()
        return
      }
      if (result.cores.length === 0) {
        statusMessage = "No cores installed at all yet, get one from RetroArch's own Core Downloader"
        render()
        return
      }
      availableCores = result.cores
      coreIndex = Math.max(0, availableCores.indexOf(currentCoreFilename))
      zone = 'selectCore'
      statusMessage = ''
      render()
    }

    async function selectCore(system, filename) {
      config.cores[system.id] = filename
      saveConfig(config)
      zone = 'games'
      statusMessage = 'Core set to ' + filename
      render()
      await refreshCurrentCore(system)
      render()
    }

    async function launchGame(system, game) {
      if (!retroArchDir) {
        statusMessage = 'RetroArch not found, see above'
        render()
        return
      }
      var core = await RetroArchAdapter.findCore(retroArchDir, config.cores[system.id], system.cores)
      if (!core.path) {
        statusMessage = coreStatusMessage || system.name + ' has no usable core, see Change Core'
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
      else if (zone === 'selectCore') root.appendChild(renderSelectCore())
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
                  retroArchDir ? retroArchDir + ' (press Confirm to change)' : 'Not found (press Confirm to locate it)'
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
                folder ? folder : 'Not set up (press Confirm to pick a folder)'
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
          system.name + ' (' + games.length + ' found, core: ' + (currentCoreFilename || 'none') + ')'
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
        if (row.kind === 'changeCore') {
          list.appendChild(
            h(
              'div',
              {
                onclick: function () {
                  gameIndex = i
                  changeCoreForSystem(system)
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
              ['Change Core' + (currentCoreFilename ? ' (' + currentCoreFilename + ')' : ' (none selected)')]
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

    // Every .dll actually present in RetroArch's cores folder, not just
    // this system's suggested defaults — real free choice, not a
    // restricted list.
    function renderSelectCore() {
      var system = currentSystem()
      var wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', overflow: 'hidden', flex: '1' } })
      wrap.appendChild(
        h('h2', { style: { fontSize: '16px', margin: '0 0 4px 0', color: COLORS.muted } }, [
          'Pick a core for ' + system.name
        ])
      )
      var list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', overflowY: 'auto' } })
      availableCores.forEach(function (filename, i) {
        var focused = i === coreIndex
        var isCurrent = filename === currentCoreFilename
        list.appendChild(
          h(
            'div',
            {
              onclick: function () {
                coreIndex = i
                selectCore(system, filename)
              },
              style: {
                background: focused ? COLORS.accent : COLORS.panel,
                borderRadius: '8px',
                padding: '10px 16px',
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between'
              }
            },
            [filename, isCurrent ? h('span', { style: { fontSize: '12px' } }, ['current']) : null]
          )
        )
      })
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
      if (zone === 'selectCore') {
        if (action === 'up') coreIndex = Math.max(0, coreIndex - 1)
        else if (action === 'down') coreIndex = Math.min(availableCores.length - 1, coreIndex + 1)
        else if (action === 'confirm' && availableCores[coreIndex]) {
          selectCore(currentSystem(), availableCores[coreIndex])
        } else if (action === 'back' || action === 'menu') {
          zone = 'games'
          statusMessage = ''
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
        else if (gRow.kind === 'changeCore') changeCoreForSystem(currentSystem())
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
