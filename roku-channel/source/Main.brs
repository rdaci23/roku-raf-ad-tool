sub Main(args as Dynamic)
    screen = CreateObject("roSGScreen")
    m.port = CreateObject("roMessagePort")
    screen.setMessagePort(m.port)

    inputObj = CreateObject("roInput")
    inputObj.SetMessagePort(m.port)

    scene = screen.CreateScene("MainScene")
    screen.show()

    ' Observe appExit field if needed and pass initial ECP launch args
    if args <> invalid
        scene.launchArgs = args
    end if

    while true
        msg = wait(0, m.port)
        msgType = type(msg)
        if msgType = "roSGScreenEvent"
            if msg.isScreenClosed() then return
        else if msgType = "roInputEvent"
            info = msg.GetInfo()
            if info <> invalid
                scene.externalInput = info
            end if
        end if
    end while
end sub
