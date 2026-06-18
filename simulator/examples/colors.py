# Two ways to make a colour:
#   color.rgb(r, g, b)  — channels 0-255, optional 4th alpha argument
#   color.hsv(h, s, v)  — components 0.0-1.0, great for sweeping hues
# Common colours are also available by name, e.g. color.red.

from math import sin

badge.mode(HIRES)

named = [color.red, color.green, color.blue, color.orange, color.grape]

while True:
    # A rainbow of hues across the screen using HSV.
    for x in range(0, screen.width, 8):
        screen.pen = color.hsv(x / screen.width, 1.0, 1.0)
        screen.rectangle(x, 0, 8, 110)

    # Named colour swatches.
    for i, c in enumerate(named):
        screen.pen = c
        screen.rectangle(10 + i * 60, 130, 50, 50)

    # An RGB grey that pulses with time.
    v = int((sin(badge.ticks / 400) * 0.5 + 0.5) * 255)
    screen.pen = color.rgb(v, v, v)
    screen.text("color.rgb / color.hsv", 10, 200)

    badge.update()
