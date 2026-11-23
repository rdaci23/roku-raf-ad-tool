Library "Roku_Ads.brs"

sub init()
    m.top.functionName = "runAdSession"
end sub

sub emitTelemetry(eventName as String, detail as String)
    m.top.statusMessage = eventName + ": " + detail
    if m.top.telemetryUrl = "" then return

    if m.pendingTransfers = invalid then m.pendingTransfers = []
    port = CreateObject("roMessagePort")
    http = CreateObject("roUrlTransfer")
    http.SetMessagePort(port)
    http.SetCertificatesFile("common:/certs/ca-bundle.crt")
    http.InitClientCertificates()
    http.SetUrl(m.top.telemetryUrl)
    http.AddHeader("Content-Type", "application/json")
    payload = FormatJson({
        eventName: eventName,
        detail: detail,
        adMode: m.top.adMode,
        adTagUrl: m.top.adTagUrl
    })
    http.AsyncPostFromString(payload)
    m.pendingTransfers.Push(http)
    if m.pendingTransfers.Count() > 16
        m.pendingTransfers.Shift()
    end if
end sub

sub rafTrackingCallback(obj = Invalid as Dynamic, eventType = Invalid as Dynamic, ctx = Invalid as Dynamic)
    evStr = ""
    if eventType <> invalid then evStr = FormatJson(eventType)
    adInfo = ""
    if ctx <> invalid and type(ctx) = "roAssociativeArray"
        if ctx.adIndex <> invalid then adInfo = "adIndex=" + ctx.adIndex.ToStr() + " "
        if ctx.errMsg <> invalid then adInfo = adInfo + "err=" + ctx.errMsg
    end if
    emitTelemetry("RAF_" + evStr, adInfo)
end sub

sub configureRafInstance(raf as Object, video as Object)
    raf.setDebugOutput(true)
    raf.enableAdMeasurements(m.top.enableAdMeasurements)
    raf.setAdPrefs(m.top.useFallback, m.top.maxRequests)

    res = LCase(m.top.maxResolution)
    if video <> invalid and video.hasField("maxVideoDecodeResolution")
        if res = "4k"
            video.maxVideoDecodeResolution = [3840, 2160]
        else if res = "720p"
            video.maxVideoDecodeResolution = [1280, 720]
        else
            video.maxVideoDecodeResolution = [1920, 1080]
        end if
    end if

    raf.setContentId(m.top.contentId)
    raf.setContentGenre(m.top.contentGenre)
    raf.setContentLength(m.top.contentLength)
    raf.setTrackingCallback(rafTrackingCallback, {})
end sub

function getRafViewNode(video as Object) as Object
    if m.top.adContainer <> invalid then return m.top.adContainer
    return video.getParent()
end function

sub runAdSession()
    video = m.top.videoNode
    if video = invalid
        emitTelemetry("ERROR", "Missing Video node reference")
        m.top.runFinished = true
        return
    end if

    raf = Roku_Ads()
    configureRafInstance(raf, video)

    mode = LCase(m.top.adMode)
    if mode = "csai-stitched"
        runCsaiStitchedFlow(raf, video)
    else if mode = "csai-skippable"
        runCsaiSkippableFlow(raf, video)
    else if mode = "ssai" or mode = "ssai-live"
        runSsaiFlow(raf, video, mode = "ssai-live")
    else if mode = "google-dai"
        runGoogleDaiFlow(raf, video)
    else
        runCsaiStandardFlow(raf, video)
    end if

    emitTelemetry("SESSION_FINISHED", "mode=" + mode)
    m.top.runFinished = true
end sub

sub runCsaiStandardFlow(raf as Object, video as Object)
    tagUrl = m.top.adTagUrl
    if m.top.simulateLat
        sep = "?"
        if Instr(1, tagUrl, "?") > 0 then sep = "&"
        tagUrl = tagUrl + sep + "is_lat=1&rdid=00000000-0000-0000-0000-000000000000"
    end if
    emitTelemetry("FETCH_TAG", tagUrl)
    raf.setAdUrl(tagUrl)

    adPods = raf.getAds()
    podCount = 0
    if adPods <> invalid then podCount = adPods.Count()
    emitTelemetry("PODS_PARSED", "count=" + podCount.ToStr())

    shouldPlayContent = true
    viewNode = getRafViewNode(video)

    if adPods <> invalid and podCount > 0
        emitTelemetry("PREROLL_START", "raf.showAds()")
        shouldPlayContent = raf.showAds(adPods, invalid, viewNode)
        emitTelemetry("PREROLL_END", "continueContent=" + shouldPlayContent.ToStr())
    end if

    if not shouldPlayContent then return

    port = CreateObject("roMessagePort")
    contentNode = CreateObject("roSGNode", "ContentNode")
    contentNode.url = m.top.contentUrl
    contentNode.title = m.top.contentId
    if Right(LCase(m.top.contentUrl), 5) = ".m3u8" or Instr(1, LCase(m.top.contentUrl), ".m3u8?") > 0
        contentNode.streamFormat = "hls"
    else if Right(LCase(m.top.contentUrl), 4) = ".mpd" or Instr(1, LCase(m.top.contentUrl), ".mpd?") > 0
        contentNode.streamFormat = "dash"
    else
        contentNode.streamFormat = "mp4"
    end if

    video.content = contentNode
    video.observeFieldScoped("position", port)
    video.observeFieldScoped("state", port)
    video.setFocus(true)
    emitTelemetry("CONTENT_PLAY", m.top.contentUrl)
    video.control = "play"

    playing = true
    while playing
        msg = wait(500, port)
        if type(msg) = "roSGNodeEvent"
            field = msg.getField()
            if field = "state"
                st = msg.getData()
                if st = "finished"
                    postPods = raf.getAds(msg)
                    if postPods <> invalid and postPods.Count() > 0
                        emitTelemetry("POSTROLL_START", "raf.showAds()")
                        raf.showAds(postPods, invalid, viewNode)
                    end if
                    playing = false
                else if st = "error"
                    emitTelemetry("CONTENT_ERROR", "Video playback error")
                    playing = false
                end if
            else if field = "position"
                midPods = raf.getAds(msg)
                if midPods <> invalid and midPods.Count() > 0
                    savedPos = video.position
                    video.control = "stop"
                    emitTelemetry("MIDROLL_START", "pos=" + savedPos.ToStr())
                    if raf.showAds(midPods, invalid, viewNode)
                        video.seek = savedPos
                        video.control = "play"
                    else
                        playing = false
                    end if
                end if
            end if
        end if
    end while
end sub

sub runCsaiStitchedFlow(raf as Object, video as Object)
    emitTelemetry("CSAI_STITCH_INIT", m.top.adTagUrl)
    raf.setAdUrl(m.top.adTagUrl)
    adPods = raf.getAds()

    fmt = "mp4"
    if Right(LCase(m.top.contentUrl), 5) = ".m3u8" then fmt = "hls"

    contentNode = CreateObject("roSGNode", "ContentNode")
    contentNode.url = m.top.contentUrl
    contentNode.streamFormat = fmt
    contentNode.title = m.top.contentId
    contentNode.length = m.top.contentLength

    viewNode = getRafViewNode(video)
    stitched = raf.constructStitchedStream(contentNode, adPods)
    emitTelemetry("CSAI_STITCH_RENDER", "raf.renderStitchedStream()")
    completed = raf.renderStitchedStream(stitched, viewNode)
    emitTelemetry("CSAI_STITCH_END", "completed=" + completed.ToStr())
end sub

sub fireBeaconUrl(url as String)
    if url = "" then return
    if m.pendingTransfers = invalid then m.pendingTransfers = []
    port = CreateObject("roMessagePort")
    http = CreateObject("roUrlTransfer")
    http.SetMessagePort(port)
    http.SetCertificatesFile("common:/certs/ca-bundle.crt")
    http.InitClientCertificates()
    http.SetUrl(url)
    http.AsyncGetToString()
    m.pendingTransfers.Push(http)
    if m.pendingTransfers.Count() > 24 then m.pendingTransfers.Shift()
end sub

sub collectVastTrackingByEvent(xmlNode as Object, targetEvent as String, results as Object)
    if xmlNode = invalid then return
    name = LCase(xmlNode.GetName())
    if Right(name, 8) = "tracking"
        attrs = xmlNode.GetAttributes()
        if attrs <> invalid and attrs.event <> invalid and LCase(attrs.event) = LCase(targetEvent)
            body = xmlNode.GetBody().Trim()
            if body <> "" then results.Push(body)
        end if
    end if
    children = xmlNode.GetChildElements()
    if children <> invalid
        for each child in children
            collectVastTrackingByEvent(child, targetEvent, results)
        end for
    end if
end sub

sub runCsaiSkippableFlow(raf as Object, video as Object)
    emitTelemetry("SKIPPABLE_INIT", m.top.adTagUrl)
    http = CreateObject("roUrlTransfer")
    http.SetCertificatesFile("common:/certs/ca-bundle.crt")
    http.InitClientCertificates()
    http.SetUrl(m.top.adTagUrl)
    rawVast = http.GetToString()
    if rawVast = ""
        emitTelemetry("SKIPPABLE_ERROR", "Empty VAST response")
        return
    end if

    skipOffsetSec = 5
    rxSkip = CreateObject("roRegex", "skipoffset\s*=\s*""(\d+):(\d+):(\d+)""", "i")
    mSkip = rxSkip.Match(rawVast)
    if mSkip.Count() >= 4
        skipOffsetSec = mSkip[1].ToInt() * 3600 + mSkip[2].ToInt() * 60 + mSkip[3].ToInt()
    end if

    skipUrls = []
    closeUrls = []
    xmlRoot = CreateObject("roXMLElement")
    if xmlRoot.Parse(rawVast)
        collectVastTrackingByEvent(xmlRoot, "skip", skipUrls)
        collectVastTrackingByEvent(xmlRoot, "closeLinear", closeUrls)
    end if

    raf.setAdUrl(m.top.adTagUrl)
    adPods = raf.getAds()

    if adPods = invalid or adPods.Count() = 0 or adPods[0].ads = invalid or adPods[0].ads.Count() = 0
        emitTelemetry("SKIPPABLE_NO_ADS", "No playable ads in pod")
        return
    end if

    spot = adPods[0].ads[0]
    dur = spot.duration
    if dur = invalid or dur <= 0 then dur = 12

    adNode = CreateObject("roSGNode", "ContentNode")
    adNode.url = spot.streams[0].url
    adNode.streamFormat = "mp4"
    adNode.title = "Skippable Ad"

    port = CreateObject("roMessagePort")
    m.top.canSkipNow = false
    m.top.skipRequested = false
    m.top.observeFieldScoped("skipRequested", port)

    if m.top.skipLabelNode <> invalid
        m.top.skipLabelNode.text = "Skip Ad in " + skipOffsetSec.ToStr() + "s"
    end if
    if m.top.skipOverlayNode <> invalid
        m.top.skipOverlayNode.visible = true
        m.top.skipOverlayNode.setFocus(true)
    end if

    video.enableUI = false
    video.content = adNode
    video.observeFieldScoped("position", port)
    video.observeFieldScoped("state", port)
    video.control = "play"

    started = false
    q1Sent = false
    midSent = false
    q3Sent = false
    adPlaying = true

    while adPlaying
        msg = wait(250, port)
        if m.top.skipRequested = true
            curPos = video.position
            video.control = "stop"
            for each u in skipUrls
                fireBeaconUrl(u)
            end for
            for each u in closeUrls
                fireBeaconUrl(u)
            end for
            emitTelemetry("AD_SKIPPED", "pos=" + curPos.ToStr())
            adPlaying = false
        else if type(msg) = "roSGNodeEvent"
            fld = msg.getField()
            if fld = "state"
                st = msg.getData()
                if st = "playing" and not started
                    started = true
                    for each trk in spot.tracking
                        evLower = LCase(trk.event)
                        if evLower = "impression" or evLower = "start"
                            fireBeaconUrl(trk.url)
                        end if
                    end for
                    emitTelemetry("PREROLL_START", "skipoffset=" + skipOffsetSec.ToStr() + "s")
                else if st = "finished"
                    for each trk in spot.tracking
                        if LCase(trk.event) = "complete" then fireBeaconUrl(trk.url)
                    end for
                    adPlaying = false
                else if st = "error"
                    adPlaying = false
                end if
            else if fld = "position"
                playPos = video.position
                if playPos >= dur * 0.25 and not q1Sent
                    q1Sent = true
                    for each trk in spot.tracking
                        if LCase(trk.event) = "firstquartile" then fireBeaconUrl(trk.url)
                    end for
                end if
                if playPos >= dur * 0.50 and not midSent
                    midSent = true
                    for each trk in spot.tracking
                        if LCase(trk.event) = "midpoint" then fireBeaconUrl(trk.url)
                    end for
                end if
                if playPos >= dur * 0.75 and not q3Sent
                    q3Sent = true
                    for each trk in spot.tracking
                        if LCase(trk.event) = "thirdquartile" then fireBeaconUrl(trk.url)
                    end for
                end if

                if playPos >= skipOffsetSec
                    if m.top.canSkipNow = false
                        m.top.canSkipNow = true
                        if m.top.skipLabelNode <> invalid then m.top.skipLabelNode.text = "Press OK to Skip Ad >>"
                        emitTelemetry("SKIP_UNLOCKED", "offset=" + skipOffsetSec.ToStr() + "s")
                    end if
                else if m.top.skipLabelNode <> invalid
                    remSec = Int(skipOffsetSec - playPos + 0.99)
                    m.top.skipLabelNode.text = "Skip Ad in " + remSec.ToStr() + "s"
                end if
            end if
        end if
    end while

    if m.top.skipOverlayNode <> invalid then m.top.skipOverlayNode.visible = false
    video.enableUI = true
    emitTelemetry("PREROLL_END", "continueContent=true")

    contentNode = CreateObject("roSGNode", "ContentNode")
    contentNode.url = m.top.contentUrl
    contentNode.streamFormat = "mp4"
    video.content = contentNode
    video.setFocus(true)
    video.control = "play"
    wait(1800, port)
end sub

function fetchJson(url as String) as Dynamic
    if url = "" then return invalid
    http = CreateObject("roUrlTransfer")
    http.SetCertificatesFile("common:/certs/ca-bundle.crt")
    http.InitClientCertificates()
    http.SetUrl(url)
    raw = http.GetToString()
    if raw = "" then return invalid
    return ParseJson(raw)
end function

sub runSsaiFlow(raf as Object, video as Object, isLive as Boolean)
    emitTelemetry("SSAI_INIT", "live=" + isLive.ToStr() + " meta=" + m.top.ssaiMetaUrl)
    fetched = fetchJson(m.top.ssaiMetaUrl)
    adPods = []
    if type(fetched) = "roArray"
        adPods = fetched
    else if type(fetched) = "roAssociativeArray" and fetched.ad_pods <> invalid
        adPods = fetched.ad_pods
    end if
    raf.stitchedAdsInit(adPods)

    port = CreateObject("roMessagePort")
    contentNode = CreateObject("roSGNode", "ContentNode")
    contentNode.url = m.top.contentUrl
    contentNode.title = "SSAI Stitched HLS"
    contentNode.streamFormat = "hls"

    video.content = contentNode
    video.observeFieldScoped("position", port)
    video.observeFieldScoped("state", port)
    video.observeFieldScoped("timedMetaData", port)
    video.setFocus(true)
    video.control = "play"

    player = { sgNode: video, port: port }
    lastPollSec = 0
    playing = true
    while playing
        msg = wait(500, port)
        if msg <> invalid
            adHandled = raf.stitchedAdHandledEvent(msg, player)
            if adHandled <> invalid and adHandled.adExited = true
                emitTelemetry("SSAI_EXIT", "User exited during stitched ad")
                playing = false
            else if type(msg) = "roSGNodeEvent"
                field = msg.getField()
                if field = "state"
                    st = msg.getData()
                    if st = "finished" or st = "error"
                        emitTelemetry("SSAI_END", "state=" + st)
                        playing = false
                    end if
                else if field = "position" and isLive and m.top.ssaiMetaUrl <> ""
                    curPos = Int(video.position)
                    if curPos - lastPollSec >= 6
                        lastPollSec = curPos
                        polled = fetchJson(m.top.ssaiMetaUrl)
                        nextPods = []
                        if type(polled) = "roArray"
                            nextPods = polled
                        else if type(polled) = "roAssociativeArray" and polled.ad_pods <> invalid
                            nextPods = polled.ad_pods
                        end if
                        if nextPods.Count() > adPods.Count()
                            adPods = nextPods
                            raf.stitchedAdsInit(adPods)
                        end if
                    end if
                end if
            end if
        end if
    end while
end sub

sub runGoogleDaiFlow(raf as Object, video as Object)
    emitTelemetry("DAI_BOOTSTRAP", m.top.adTagUrl)
    devInfo = CreateObject("roDeviceInfo")
    isLat = devInfo.IsRIDADisabled()
    rida = devInfo.GetRIDA()
    latStr = "0"
    if isLat
        latStr = "1"
        rida = "00000000-0000-0000-0000-000000000000"
    end if

    port = CreateObject("roMessagePort")
    req = CreateObject("roUrlTransfer")
    req.SetMessagePort(port)
    req.SetCertificatesFile("common:/certs/ca-bundle.crt")
    req.InitClientCertificates()
    req.SetUrl(m.top.adTagUrl)
    req.AddHeader("Content-Type", "application/x-www-form-urlencoded")

    rawResp = ""
    if req.AsyncPostFromString("rdid=" + rida + "&idtype=rida&is_lat=" + latStr)
        ev = wait(8000, port)
        if type(ev) = "roUrlEvent" and ev.GetResponseCode() >= 200 and ev.GetResponseCode() < 300
            rawResp = ev.GetString()
        end if
    end if

    daiSession = invalid
    if rawResp <> "" then daiSession = ParseJson(rawResp)

    if daiSession = invalid or daiSession.stream_manifest = invalid
        emitTelemetry("DAI_ERROR", "Failed to create DAI stream session")
        return
    end if

    m.top.contentUrl = daiSession.stream_manifest
    if daiSession.metadata_url <> invalid then m.top.ssaiMetaUrl = daiSession.metadata_url
    if daiSession.ad_pods <> invalid then raf.stitchedAdsInit(daiSession.ad_pods)

    isLive = (Instr(1, LCase(m.top.adTagUrl), "/live/") > 0)
    runSsaiFlow(raf, video, isLive)
end sub
