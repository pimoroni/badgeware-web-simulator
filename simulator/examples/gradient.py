# brush.gradient builds a fill you assign to the pen, just like a colour.
#
# The gradient lives in a 0..1 coordinate space; a mat3 maps that space onto
# the pixels you draw into. Here we stretch a vertical gradient (axis 0,0 to
# 0,1) across the whole screen.

badge.mode(HIRES)

fill = brush.gradient(brush.LINEAR, 0, 0, 0, 1, [
    (0.0, color.rgb(255, 120, 0)),
    (0.5, color.rgb(200, 0, 120)),
    (1.0, color.rgb(0, 40, 120)),
], mat3().scale(screen.width, screen.height))

while True:
    screen.pen = fill
    screen.shape(shape.rectangle(0, 0, screen.width, screen.height))

    screen.pen = color.white
    screen.text("brush.gradient", 10, 10)

    badge.update()
