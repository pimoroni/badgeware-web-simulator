# Welcome to Badgeware!
#
# Every app follows the same shape: set things up, then loop forever. Each
# time round the loop you draw a frame and call badge.update(), which pushes
# your drawing to the screen and reads the buttons.

from math import sin, cos, pi

badge.mode(HIRES)

while True:
    # Build a wobbling flower outline from polar coordinates.
    petals = []
    for deg in range(0, 360, 5):
        wobble = sin((deg + badge.ticks / 50) * 5 * pi / 180) * (screen.height // 12)
        radius = wobble + screen.height // 4
        x = sin(deg * pi / 180) * radius + screen.width // 2
        y = cos(deg * pi / 180) * radius + screen.height // 2
        petals.append(vec2(x, y))

    screen.antialias = image.X2
    screen.pen = color.rgb(255, 80, 160)
    screen.shape(shape.custom(petals))

    screen.pen = color.white
    screen.text("Hello World", 10, 10)

    badge.update()
