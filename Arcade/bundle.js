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
  // read. If neither is right, Locate RetroArch Folder below covers it.
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

  // ---------------------------------------------------------------------
  // RetroArch adapter — one plain object, not a class. A second,
  // structurally different emulator later is a second object implementing
  // the same five methods its own way (detect/findCore/listRoms/
  // buildLaunchArgs/launch), not a subclass of this one.
  // ---------------------------------------------------------------------
  var RetroArchAdapter = {
    // -> dir path or null. Never installs anything, only ever looks.
    detect: async function (config) {
      if (config.retroArchDir) {
        var cached = await this._hasExe(config.retroArchDir)
        if (cached) return config.retroArchDir
      }
      for (var i = 0; i < RETROARCH_CANDIDATE_DIRS.length; i++) {
        var dir = RETROARCH_CANDIDATE_DIRS[i]
        if (await this._hasExe(dir)) return dir
      }
      return null
    },

    _hasExe: async function (dir) {
      try {
        var entries = await api.listDir(dir)
        return entries.indexOf('retroarch.exe') !== -1
      } catch (e) {
        return false
      }
    },

    // -> core file path or null. Standard portable-layout convention:
    // cores live in a `cores` folder alongside retroarch.exe itself.
    findCore: async function (retroArchDir, coreFilename) {
      var coresDir = retroArchDir + '\\cores'
      try {
        var entries = await api.listDir(coresDir)
        return entries.indexOf(coreFilename) !== -1 ? coresDir + '\\' + coreFilename : null
      } catch (e) {
        return null
      }
    },

    // -> array of { name, path }, filtered by this system's extensions.
    listRoms: async function (folderPath, extensions) {
      var entries
      try {
        entries = await api.listDir(folderPath)
      } catch (e) {
        return null
      }
      var roms = []
      for (var i = 0; i < entries.length; i++) {
        var name = entries[i]
        var dot = name.lastIndexOf('.')
        if (dot === -1) continue
        var ext = name.slice(dot).toLowerCase()
        if (extensions.indexOf(ext) === -1) continue
        roms.push({ name: name.slice(0, dot), path: folderPath + '\\' + name })
      }
      roms.sort(function (a, b) {
        return a.name.localeCompare(b.name)
      })
      return roms
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
    muted: '#8f8fa3',
    danger: '#f87171'
  }

  function mount(root, api) {
    // ---- state ----
    var config = loadConfig()
    var zone = 'systems' // 'systems' | 'games'
    var systemIndex = 0
    var gameIndex = 0
    var games = [] // currently-shown ROM list for the selected system
    var statusMessage = ''
    var retroArchDir = null
    var detecting = true

    root.style.cssText =
      'background:' +
      COLORS.bg +
      ';color:#fff;font-family:sans-serif;height:100%;display:flex;flex-direction:column;' +
      'padding:32px;box-sizing:border-box;gap:16px;overflow:hidden'

    async function ensureRetroArch() {
      detecting = true
      render()
      retroArchDir = await RetroArchAdapter.detect(config)
      if (retroArchDir && retroArchDir !== config.retroArchDir) {
        config.retroArchDir = retroArchDir
        saveConfig(config)
      }
      detecting = false
      render()
    }

    async function locateRetroArchFolder() {
      var folder = await api.pickFolder()
      if (!folder) return
      var hasExe = await RetroArchAdapter._hasExe(folder)
      if (!hasExe) {
        statusMessage = "That folder doesn't have retroarch.exe in it"
        render()
        return
      }
      retroArchDir = folder
      config.retroArchDir = folder
      saveConfig(config)
      statusMessage = 'Found RetroArch'
      render()
    }

    async function assignFolder(system) {
      var folder = await api.pickFolder()
      if (!folder) return
      config.folders[system.id] = folder
      saveConfig(config)
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
      var roms = await RetroArchAdapter.listRoms(folder, system.extensions)
      if (roms === null) {
        statusMessage = "Couldn't read " + folder + ' anymore — the folder may have moved'
        render()
        return
      }
      games = roms
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
      var corePath = await RetroArchAdapter.findCore(retroArchDir, system.core)
      if (!corePath) {
        statusMessage =
          system.name + " needs the " + system.core + " core, not installed. Get it from RetroArch's own Core Downloader."
        render()
        return
      }
      statusMessage = 'Launching ' + game.name + '...'
      render()
      var result = await RetroArchAdapter.launch(retroArchDir, corePath, game.path)
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

      if (!detecting && !retroArchDir) {
        root.appendChild(
          h(
            'div',
            {
              style: {
                background: COLORS.panel,
                borderRadius: '10px',
                padding: '14px 18px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px'
              }
            },
            [
              h('span', { style: { fontSize: '13px', color: COLORS.muted } }, [
                "Couldn't find RetroArch automatically. It needs to already be installed — Arcade never installs it for you."
              ]),
              h(
                'button',
                {
                  style: {
                    background: COLORS.accent,
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '8px 16px',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap'
                  },
                  onclick: locateRetroArchFolder
                },
                ['Locate RetroArch Folder']
              )
            ]
          )
        )
      }

      if (zone === 'systems') root.appendChild(renderSystems())
      else root.appendChild(renderGames())

      if (statusMessage) {
        root.appendChild(h('p', { style: { color: COLORS.muted, fontSize: '13px', margin: '0' } }, [statusMessage]))
      }
    }

    function renderSystems() {
      var list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto' } })
      SYSTEMS.forEach(function (system, i) {
        var folder = config.folders[system.id]
        var focused = zone === 'systems' && i === systemIndex
        list.appendChild(
          h(
            'div',
            {
              onclick: function () {
                systemIndex = i
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

    function renderGames() {
      var system = SYSTEMS[systemIndex]
      var wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', overflow: 'hidden', flex: '1' } })
      wrap.appendChild(
        h('h2', { style: { fontSize: '16px', margin: '0 0 4px 0', color: COLORS.muted } }, [
          system.name + ' — ' + games.length + ' found'
        ])
      )
      var list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', overflowY: 'auto' } })
      if (games.length === 0) {
        list.appendChild(h('p', { style: { color: COLORS.muted, fontSize: '13px' } }, ['No matching ROM files in that folder.']))
      }
      games.forEach(function (game, i) {
        var focused = i === gameIndex
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
      wrap.appendChild(list)
      return wrap
    }

    // ---- nav ----
    api.onNav(function (action) {
      if (zone === 'systems') {
        if (action === 'up') systemIndex = Math.max(0, systemIndex - 1)
        else if (action === 'down') systemIndex = Math.min(SYSTEMS.length - 1, systemIndex + 1)
        else if (action === 'confirm') openSystem(SYSTEMS[systemIndex])
        else if (action === 'back' || action === 'menu') api.exit()
        else return
        render()
        return
      }
      // zone === 'games'
      if (action === 'up') gameIndex = Math.max(0, gameIndex - 1)
      else if (action === 'down') gameIndex = Math.min(Math.max(0, games.length - 1), gameIndex + 1)
      else if (action === 'confirm' && games[gameIndex]) launchGame(SYSTEMS[systemIndex], games[gameIndex])
      else if (action === 'back' || action === 'menu') {
        zone = 'systems'
        statusMessage = ''
      } else return
      render()
    })

    render()
    ensureRetroArch()
  }

  window.ClashPointPlugin = { mount: mount }
})()
