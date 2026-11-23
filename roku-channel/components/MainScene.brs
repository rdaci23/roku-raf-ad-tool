sub init()
    m.menuOverlay = m.top.findNode("menuOverlay")
    m.contentVideo = m.top.findNode("contentVideo")
    m.adContainer = m.top.findNode("adContainer")
    m.presetList = m.top.findNode("presetList")
    m.listModeLabel = m.top.findNode("listModeLabel")
    m.serverUrlLabel = m.top.findNode("serverUrlLabel")
    m.prefsSummaryLabel = m.top.findNode("prefsSummaryLabel")
    m.activeTagLabel = m.top.findNode("activeTagLabel")
    m.consoleOutput = m.top.findNode("consoleOutput")
    m.playbackHud = m.top.findNode("playbackHud")
    m.hudMetaLabel = m.top.findNode("hudMetaLabel")
    m.hudStatusLabel = m.top.findNode("hudStatusLabel")
    m.skipOverlay = m.top.findNode("skipOverlay")
    m.skipLabel = m.top.findNode("skipLabel")

    m.logLines = []
    m.hudLines = []
    m.adTask = invalid
    m.showingHistory = false

    ' Configurable Runtime RAF Prefs
    m.csaiModes = ["csai", "csai-stitched", "csai-skippable"]
    m.csaiModeIdx = 0
    m.maxResolution = "1080p"
    m.enableAdMeasurements = true
    m.useFallback = false
    m.maxRequests = 5
    m.contentId = "ep-101-pilot"
    m.contentGenre = "Action,Science fiction"
    m.contentLength = 1800
    m.showDebugHud = true
    m.simulateLat = false

    appInfo = CreateObject("roAppInfo")
    defaultServer = appInfo.GetValue("raf_tool_server_url")
    if defaultServer = "" or defaultServer = invalid then defaultServer = "http://127.0.0.1:4321"

    reg = CreateObject("roRegistrySection", "RafAdTool")
    if reg.Exists("serverUrl")
        m.serverUrl = reg.Read("serverUrl")
    else
        m.serverUrl = defaultServer
    end if
    m.sessionId = "roku-tv"

    m.historyItems = loadBookmarkHistory()
    updateHeaders()
    populatePresets()

    m.presetList.observeField("itemSelected", "onItemSelected")
    m.presetList.setFocus(true)
    appendLog("RAF v2 Harness ready (showAds, constructStitchedStream, VOD/Live SSAI, Google DAI).")
end sub

function loadBookmarkHistory() as Object
    reg = CreateObject("roRegistrySection", "RafAdToolHistory")
    if reg.Exists("items")
        parsed = ParseJson(reg.Read("items"))
        if parsed <> invalid and type(parsed) = "roArray" then return parsed
    end if
    return []
end function

sub saveToBookmarkHistory(adTagUrl as String, adMode as String, ssaiMetaUrl as String)
    filtered = []
    entry = {
        title: "[" + UCase(adMode) + "] " + Right(adTagUrl, 52),
        adTagUrl: adTagUrl,
        adMode: adMode,
        ssaiMetaUrl: ssaiMetaUrl
    }
    filtered.Push(entry)
    for each existing in m.historyItems
        if existing.adTagUrl <> adTagUrl and filtered.Count() < 10
            filtered.Push(existing)
        end if
    end for
    m.historyItems = filtered
    reg = CreateObject("roRegistrySection", "RafAdToolHistory")
    reg.Write("items", FormatJson(filtered))
    reg.Flush()
end sub

sub updateHeaders()
    devInfo = CreateObject("roDeviceInfo")
    latStr = "OFF"
    if devInfo.IsRIDADisabled() then latStr = "ON"
    m.serverUrlLabel.text = "Server: " + m.serverUrl + "  |  Session: " + m.sessionId + "  |  Device LAT: " + latStr
    measStr = "OFF"
    if m.enableAdMeasurements then measStr = "ON"
    hudStr = "OFF"
    if m.showDebugHud then hudStr = "ON"
    m.prefsSummaryLabel.text = "Default CSAI Mode: " + m.csaiModes[m.csaiModeIdx] + "  |  MaxRes: " + m.maxResolution + "  |  Measurements: " + measStr + "  |  HUD (*): " + hudStr
end sub

sub populatePresets()
    m.showingHistory = false
    m.listModeLabel.text = "BUILT-IN SCENARIOS (OK=Run | Play=Recent Bookmarks | Rew/Fwd=CSAI Mode)"
    listContent = CreateObject("roSGNode", "ContentNode")
    presets = [
        { title: "1. Single Preroll VAST 4.0", mode: "auto-csai", path: "/mock/vast/single-preroll.xml" },
        { title: "2. 3-Spot Pod + Skippable + Buffet", mode: "auto-csai", path: "/mock/vast/pod-3-ads.xml" },
        { title: "3. GAM VMAP Schedule (Pre + Mid + Post)", mode: "auto-csai", path: "/mock/vast/gam-vmap-pod.xml" },
        { title: "4. SpringServe 3-Spot CTV Pod", mode: "auto-csai", path: "/mock/vast/springserve-pod.xml" },
        { title: "5. 2-Hop Wrapper Chain", mode: "auto-csai", path: "/mock/vast/wrapper-chain.xml?depth=2" },
        { title: "6. SSAI VOD Stitched HLS + DATERANGE", mode: "ssai", path: "/mock/ssai/stream.m3u8" },
        { title: "7. SSAI Live Linear HLS (Cue SCTE-35 from UI)", mode: "ssai-live", path: "/mock/live/master.m3u8" },
        { title: "8. Google DAI VOD Stream Session", mode: "google-dai", path: "/mock/dai/ondemand/hls/content/2548831/vid/pilot/streams" },
        { title: "9. Error Test: Broken Media 404 (401/405)", mode: "auto-csai", path: "/mock/vast/error-media-404.xml" },
        { title: "10. Error Test: JS VPAID Only (RAF 403)", mode: "auto-csai", path: "/mock/vast/error-vpaid-only.xml" }
    ]
    m.presets = presets
    for each p in presets
        item = listContent.CreateChild("ContentNode")
        item.title = p.title
    end for
    m.presetList.content = listContent
end sub

sub populateHistoryList()
    m.showingHistory = true
    m.listModeLabel.text = "BOOKMARKED RECENT TAGS IN roRegistry (OK=Re-run | Play=Back to Presets)"
    listContent = CreateObject("roSGNode", "ContentNode")
    if m.historyItems.Count() = 0
        emptyNode = listContent.CreateChild("ContentNode")
        emptyNode.title = "(No recent tags saved yet)"
    else
        for each h in m.historyItems
            item = listContent.CreateChild("ContentNode")
            item.title = h.title
        end for
    end if
    m.presetList.content = listContent
end sub

sub appendLog(line as String)
    ts = CreateObject("roDateTime")
    ts.ToLocalTime()
    stamp = Right("0" + ts.GetHours().ToStr(), 2) + ":" + Right("0" + ts.GetMinutes().ToStr(), 2) + ":" + Right("0" + ts.GetSeconds().ToStr(), 2)
    entry = "[" + stamp + "] " + line
    print "[RAF-HARNESS] " ; entry
    m.logLines.Push(entry)
    if m.logLines.Count() > 22 then m.logLines.Shift()
    joined = ""
    for each l in m.logLines
        if joined <> "" then joined = joined + chr(10)
        joined = joined + l
    end for
    m.consoleOutput.text = joined

    m.hudLines.Push(entry)
    if m.hudLines.Count() > 3 then m.hudLines.Shift()
    hudJoined = ""
    for each hl in m.hudLines
        if hudJoined <> "" then hudJoined = hudJoined + chr(10)
        hudJoined = hudJoined + hl
    end for
    m.hudStatusLabel.text = hudJoined
end sub

sub onLaunchArgs()
    if m.top.launchArgs <> invalid then handleExternalParams(m.top.launchArgs)
end sub

sub onExternalInput()
    if m.top.externalInput <> invalid then handleExternalParams(m.top.externalInput)
end sub

sub handleExternalParams(params as Object)
    if params.serverUrl <> invalid and params.serverUrl <> ""
        m.serverUrl = params.serverUrl
        reg = CreateObject("roRegistrySection", "RafAdTool")
        reg.Write("serverUrl", m.serverUrl)
        reg.Flush()
    end if
    if params.sessionId <> invalid and params.sessionId <> "" then m.sessionId = params.sessionId
    if params.maxResolution <> invalid and params.maxResolution <> "" then m.maxResolution = params.maxResolution
    if params.enableAdMeasurements <> invalid then m.enableAdMeasurements = (params.enableAdMeasurements = "1" or params.enableAdMeasurements = "true")
    if params.useFallback <> invalid then m.useFallback = (params.useFallback = "1" or params.useFallback = "true")
    if params.maxRequests <> invalid then m.maxRequests = params.maxRequests.ToInt()
    if params.contentId <> invalid and params.contentId <> "" then m.contentId = params.contentId
    if params.contentGenre <> invalid and params.contentGenre <> "" then m.contentGenre = params.contentGenre
    if params.contentLength <> invalid then m.contentLength = params.contentLength.ToInt()
    if params.mediaType <> invalid and params.mediaType <> ""
        mt = LCase(params.mediaType)
        if mt = "shortformvideo"
            m.contentLength = 300
        else if mt = "movie"
            m.contentLength = 5400
        end if
    end if
    if params.showDebugHud <> invalid then m.showDebugHud = (params.showDebugHud = "1" or params.showDebugHud = "true")
    if params.simulateLat <> invalid then m.simulateLat = (params.simulateLat = "1" or params.simulateLat = "true")

    updateHeaders()

    if params.adTagUrl <> invalid and params.adTagUrl <> ""
        adMode = m.csaiModes[m.csaiModeIdx]
        if params.adMode <> invalid and params.adMode <> "" then adMode = params.adMode
        contentUrl = m.serverUrl + "/media/content-main.mp4"
        if params.contentUrl <> invalid and params.contentUrl <> "" then contentUrl = params.contentUrl
        ssaiMetaUrl = ""
        if params.ssaiMetaUrl <> invalid then ssaiMetaUrl = params.ssaiMetaUrl
        appendLog("ECP Launch [" + adMode + "] -> " + params.adTagUrl)
        startAdRun(params.adTagUrl, contentUrl, adMode, ssaiMetaUrl)
    else if params.mediaType <> invalid and params.mediaType <> ""
        ' Standard Roku Deep-Link Cert 4.x launch (contentId + mediaType without explicit adTagUrl)
        mt = LCase(params.mediaType)
        if mt = "live"
            liveUrl = m.serverUrl + "/mock/live/master.m3u8?session=" + m.sessionId
            liveMeta = m.serverUrl + "/mock/live/raf-metadata.json?session=" + m.sessionId
            appendLog("Deep-Link Live [" + m.contentId + "]")
            startAdRun(liveUrl, liveUrl, "ssai-live", liveMeta)
        else
            defTag = m.serverUrl + "/mock/vast/single-preroll.xml?session=" + m.sessionId
            defContent = m.serverUrl + "/media/content-main.mp4"
            appendLog("Deep-Link VOD [" + params.mediaType + " / " + m.contentId + "]")
            startAdRun(defTag, defContent, "csai", "")
        end if
    end if
end sub

sub onItemSelected()
    idx = m.presetList.itemSelected
    if m.showingHistory
        if idx < 0 or idx >= m.historyItems.Count() then return
        h = m.historyItems[idx]
        contentUrl = m.serverUrl + "/media/content-main.mp4"
        if h.adMode = "ssai" or h.adMode = "ssai-live" then contentUrl = h.adTagUrl
        startAdRun(h.adTagUrl, contentUrl, h.adMode, h.ssaiMetaUrl)
        return
    end if

    if idx < 0 or idx >= m.presets.Count() then return
    chosen = m.presets[idx]
    sep = "?"
    if Instr(1, chosen.path, "?") > 0 then sep = "&"
    fullUrl = m.serverUrl + chosen.path + sep + "session=" + m.sessionId

    mode = chosen.mode
    if mode = "auto-csai" then mode = m.csaiModes[m.csaiModeIdx]

    if mode = "ssai"
        ssaiMeta = m.serverUrl + "/mock/ssai/raf-metadata.json?session=" + m.sessionId
        startAdRun(fullUrl, fullUrl, mode, ssaiMeta)
    else if mode = "ssai-live"
        liveMeta = m.serverUrl + "/mock/live/raf-metadata.json?session=" + m.sessionId
        startAdRun(fullUrl, fullUrl, mode, liveMeta)
    else if mode = "google-dai"
        startAdRun(fullUrl, "", mode, "")
    else
        contentUrl = m.serverUrl + "/media/content-main.mp4"
        startAdRun(fullUrl, contentUrl, mode, "")
    end if
end sub

sub startAdRun(adTagUrl as String, contentUrl as String, adMode as String, ssaiMetaUrl as String)
    stopActiveRun()
    saveToBookmarkHistory(adTagUrl, adMode, ssaiMetaUrl)

    m.activeTagLabel.text = "Active [" + UCase(adMode) + "]: " + adTagUrl
    m.hudMetaLabel.text = "RAF HUD  |  Mode: " + UCase(adMode) + "  |  ResCap: " + m.maxResolution + "  |  Session: " + m.sessionId
    m.menuOverlay.visible = false
    m.contentVideo.visible = true
    m.playbackHud.visible = m.showDebugHud

    m.adTask = CreateObject("roSGNode", "AdPlayerTask")
    m.adTask.adTagUrl = adTagUrl
    m.adTask.contentUrl = contentUrl
    m.adTask.adMode = adMode
    m.adTask.ssaiMetaUrl = ssaiMetaUrl
    m.adTask.telemetryUrl = m.serverUrl + "/api/roku/telemetry?session=" + m.sessionId
    m.adTask.maxResolution = m.maxResolution
    m.adTask.enableAdMeasurements = m.enableAdMeasurements
    m.adTask.useFallback = m.useFallback
    m.adTask.maxRequests = m.maxRequests
    m.adTask.contentId = m.contentId
    m.adTask.contentGenre = m.contentGenre
    m.adTask.contentLength = m.contentLength
    m.adTask.simulateLat = m.simulateLat
    m.adTask.videoNode = m.contentVideo
    m.adTask.adContainer = m.adContainer
    m.adTask.skipOverlayNode = m.skipOverlay
    m.adTask.skipLabelNode = m.skipLabel
    m.adTask.canSkipNow = false
    m.adTask.skipRequested = false
    m.adTask.observeField("statusMessage", "onTaskStatus")
    m.adTask.observeField("runFinished", "onTaskFinished")
    m.adTask.control = "RUN"
end sub

sub stopActiveRun()
    if m.adTask <> invalid
        m.adTask.control = "STOP"
        m.adTask = invalid
    end if
    m.contentVideo.control = "stop"
    m.contentVideo.enableUI = true
    m.contentVideo.visible = false
    m.skipOverlay.visible = false
    m.playbackHud.visible = false
    m.menuOverlay.visible = true
    m.presetList.setFocus(true)
end sub

sub onTaskStatus()
    if m.adTask <> invalid and m.adTask.statusMessage <> ""
        appendLog(m.adTask.statusMessage)
    end if
end sub

sub onTaskFinished()
    if m.adTask <> invalid and m.adTask.runFinished = true
        appendLog("Session complete.")
        stopActiveRun()
    end if
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if key = "OK" and not m.menuOverlay.visible
        if m.adTask <> invalid and m.adTask.canSkipNow = true
            appendLog("User pressed OK — skipping ad via custom SceneGraph overlay.")
            m.adTask.skipRequested = true
            return true
        end if
    else if key = "back"
        if not m.menuOverlay.visible
            appendLog("User pressed Back — exiting active RAF playback.")
            stopActiveRun()
            return true
        end if
    else if key = "options"
        m.showDebugHud = not m.showDebugHud
        if not m.menuOverlay.visible then m.playbackHud.visible = m.showDebugHud
        updateHeaders()
        return true
    else if key = "play" and m.menuOverlay.visible
        if m.showingHistory
            populatePresets()
        else
            populateHistoryList()
        end if
        return true
    else if (key = "fastforward" or key = "rewind") and m.menuOverlay.visible
        m.csaiModeIdx = (m.csaiModeIdx + 1) mod m.csaiModes.Count()
        updateHeaders()
        return true
    end if
    return false
end function
