# text.draw lays out a string word-by-word inside a rect, wrapping as needed.
#
# Here the box width is animated so you can watch the words reflow.

from math import sin

badge.mode(HIRES)
screen.font = rom_font.sins

MESSAGE = ("Badgeware wraps long strings to fit a rectangle, breaking "
           "between words. Resize the box to reflow the text.")

while True:
    w = int(sin(badge.ticks / 800) * 60 + 170)
    bounds = rect(10, 30, w, 180)

    # Outline the layout box.
    screen.pen = color.rgb(40, 40, 60)
    screen.rectangle(bounds)

    screen.pen = color.white
    text.draw(screen, MESSAGE, bounds)

    screen.text("text.draw word wrap", 10, 10)

    badge.update()
