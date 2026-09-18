# A spritesheet is a grid over an image, numbering its cells 0..sprites-1.
# The sheet keeps no clock: divide badge.ticks by a frame time and wrap on
# sheet.sprites to play it back, or drive sprite() from a tween.

badge.mode(HIRES)

# running.png is 7 frames of 32x32 in a single row.
sheet = spritesheet.load("/system/assets/squirrel-sprites/running.png", 7, 1)

while True:
    # Advance one frame every 80ms.
    frame = sheet.sprite(badge.ticks // 80 % sheet.sprites)

    # blit(image, rect) scales the sprite into a 96x96 box.
    x = screen.width // 2 - 48
    y = screen.height // 2 - 48
    screen.blit(frame, rect(x, y, 96, 96))

    screen.pen = color.white
    screen.text("spritesheet animation", 10, 10)

    badge.update()
