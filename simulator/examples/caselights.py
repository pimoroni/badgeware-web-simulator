from math import sin, pi

badge.mode(HIRES)

PATTERNS = ["Chase", "Breathe", "Bounce", "Sparkle", "Solid"]

sel = 0
active = False
leds = [0.0, 0.0, 0.0, 0.0]

# Clockwise LED order for corner-chasing animations:
#   CL0=left-top, CL1=left-bottom, CL2=right-top, CL3=right-bottom
CW = (0, 2, 3, 1)


def chase(t):
    p = (t * 2.5) % 4
    out = [0.0] * 4
    for step, led in enumerate(CW):
        d = min(abs(p - step), 4 - abs(p - step))
        out[led] = max(0.0, 1.0 - d * 1.5)
    return out


def breathe(t):
    v = (sin(t * 1.4) * 0.5 + 0.5) ** 2
    return [v] * 4


def bounce(t):
    p = (sin(t * 2.2) * 0.5 + 0.5) * 3.0
    out = [0.0] * 4
    for step, led in enumerate(CW):
        out[led] = max(0.0, 1.0 - abs(p - step) * 1.6)
    return out


def sparkle(t):
    return [max(0.0, sin(t * (5.1 + i * 4.3) + i * 2.0) ** 8) for i in range(4)]


def solid(t):
    return [1.0, 1.0, 1.0, 1.0]


FUNS = [chase, breathe, bounce, sparkle, solid]


def update():
    global sel, active, leds

    t = badge.ticks / 1000.0

    # Navigation (only when stopped)
    if not active:
        if BUTTON_UP in badge.pressed():
            sel = (sel - 1) % len(PATTERNS)
        if BUTTON_DOWN in badge.pressed():
            sel = (sel + 1) % len(PATTERNS)

    if BUTTON_A in badge.pressed() and not active:
        active = True

    if BUTTON_B in badge.pressed():
        active = False
        leds = [0.0, 0.0, 0.0, 0.0]
        badge.caselights(0, 0, 0, 0)

    if active:
        leds = FUNS[sel](t)
        badge.caselights(*leds)

    # ── Draw ─────────────────────────────────────────────────────────
    screen.pen = color.rgb(8, 8, 20)
    screen.clear()

    # Title
    screen.pen = color.rgb(255, 140, 20)
    screen.text("CASE LIGHTS", 10, 8)

    # Pattern list
    for i, name in enumerate(PATTERNS):
        y = 46 + i * 26
        if i == sel:
            screen.pen = color.rgb(255, 140, 20)
            screen.rectangle(rect(5, y, 200, 22))
            screen.pen = color.rgb(8, 8, 20)
        else:
            screen.pen = color.rgb(160, 160, 185)
        screen.text((">" if i == sel else " ") + " " + name, 10, y + 4)

    # LED level bars — one per channel, warm white fill
    for i, v in enumerate(leds):
        bv = int(v * 255)
        x = 10 + i * 52
        screen.pen = color.rgb(25, 25, 45)
        screen.rectangle(rect(x, 200, 46, 10))
        if bv:
            screen.pen = color.rgb(bv, int(bv * 0.94), int(bv * 0.88))
            screen.rectangle(rect(x, 200, int(v * 46), 10))

    # Status / help
    if active:
        screen.pen = color.rgb(80, 210, 80)
        screen.text("RUNNING   B: stop", 10, 216)
    else:
        screen.pen = color.rgb(80, 80, 105)
        screen.text("A: run   B: stop   UP/DOWN: pick", 10, 216)
