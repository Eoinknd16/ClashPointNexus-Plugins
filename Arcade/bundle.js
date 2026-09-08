(function () {
  function h(tag, props, children) {
    var el = document.createElement(tag)
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'style') Object.assign(el.style, props[k])
        else el[k] = props[k]
      })
    }
    ;(children || []).forEach(function (c) {
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    })
    return el
  }

  function mount(root, api) {
    root.style.cssText =
      'background:#0b0b0f;color:#fff;font-family:sans-serif;height:100%;display:flex;' +
      'flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:32px;' +
      'box-sizing:border-box;text-align:center'

    var title = h('h1', { style: { fontSize: '28px', margin: '0' } }, ['Arcade — Phase 1 diagnostics'])
    var subtitle = h(
      'p',
      { style: { color: '#999', margin: '0', maxWidth: '480px' } },
      [
        'This is a foundation stub, not a real emulator frontend yet. Run the checks below to ' +
          'confirm the trusted plugin bridge works end to end.'
      ]
    )
    var log = h(
      'div',
      {
        style: {
          textAlign: 'left',
          width: '100%',
          maxWidth: '520px',
          fontFamily: 'monospace',
          fontSize: '13px',
          background: '#151519',
          borderRadius: '8px',
          padding: '16px',
          minHeight: '160px',
          whiteSpace: 'pre-wrap'
        }
      },
      []
    )
    var button = h(
      'button',
      {
        style: {
          background: '#4338ca',
          color: '#fff',
          border: 'none',
          borderRadius: '8px',
          padding: '12px 24px',
          fontSize: '15px',
          cursor: 'pointer'
        }
      },
      ['Run diagnostics']
    )
    var backHint = h('p', { style: { color: '#666', fontSize: '12px', margin: '0' } }, [
      'Press Back/Menu on the controller to exit'
    ])

    function logLine(text) {
      log.appendChild(document.createTextNode(text + '\n'))
    }

    async function runDiagnostics() {
      logLine('Querying registry (HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer)...')
      try {
        var reg = await api.queryRegistry('HKCU', 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer')
        logLine(reg ? 'OK — got ' + reg.length + ' chars back' : 'FAILED — null result')
      } catch (e) {
        logLine('FAILED — ' + e.message)
      }

      logLine('')
      logLine('Pick a folder to test file read/write...')
      try {
        var folder = await api.pickFolder()
        if (!folder) {
          logLine('Cancelled — skipping file read/write check')
        } else {
          var testPath = folder + '\\clashpoint-arcade-test.txt'
          var testContent = 'arcade phase 1 check ' + Date.now()
          await api.writeFile(testPath, testContent)
          var readBack = await api.readFile(testPath)
          logLine(readBack === testContent ? 'OK — wrote and read back ' + testPath : 'FAILED — content mismatch')
        }
      } catch (e) {
        logLine('FAILED — ' + e.message)
      }

      logLine('')
      logLine('Spawning notepad (close it to confirm Nexus restores itself)...')
      try {
        // Not a bare spawn('notepad.exe') on purpose: on many Windows 11
        // builds notepad.exe is an app-execution-alias stub for the
        // Store-packaged Notepad, and spawning that stub directly can
        // return a process handle that never actually emits 'exit' even
        // after the real window closes. `cmd /c start /wait` uses Windows'
        // own wait-for-this-app-to-finish logic instead, and is the most
        // reliable option found so far -- a console-based `pause` prompt
        // and a PowerShell message box were both tried as alternatives and
        // both failed *immediately*, unrelated to notepad's own quirks:
        // under this exact spawnProcess's detached+stdio:ignore options,
        // a nulled stdin makes `pause` return instantly, and a detached
        // process without a proper window station makes a message box
        // vanish in well under a second. Neither is usable here.
        var result = await api.spawnProcess('cmd.exe', ['/c', 'start', '/wait', 'notepad.exe'])
        logLine(result.error ? 'FAILED — ' + result.error : 'OK — launched, Nexus should minimize now')
      } catch (e) {
        logLine('FAILED — ' + e.message)
      }

      logLine('')
      logLine('Diagnostics complete.')
      button.disabled = false
    }

    button.addEventListener('click', function () {
      button.disabled = true
      log.textContent = ''
      runDiagnostics()
    })

    root.appendChild(title)
    root.appendChild(subtitle)
    root.appendChild(button)
    root.appendChild(log)
    root.appendChild(backHint)

    api.onNav(function (action) {
      if (action === 'back' || action === 'menu') api.exit()
    })
  }

  window.ClashPointPlugin = { mount: mount }
})()
