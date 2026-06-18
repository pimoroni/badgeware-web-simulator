# Load a PNG with image.load, then blit it onto the screen. Images are also
# drawing surfaces and can be processed in place — here we build a blurred
# drop shadow once at startup.

from math import sin

badge.mode(HIRES)

skull = image.load("/system/assets/skull.png")

# Make a soft shadow: copy the skull into a slightly larger buffer and blur it.
shadow = image(skull.width + 8, skull.height + 8)
shadow.blit(skull, vec2(4, 4))
shadow.blur(3)

while True:
    bob = int(sin(badge.ticks / 400) * 6)
    cx = screen.width // 2 - skull.width // 2
    cy = screen.height // 2 - skull.height // 2

    # blit(image, point) draws at a position.
    screen.blit(shadow, vec2(cx, cy + 10))
    screen.blit(skull, vec2(cx, cy + bob))

    badge.update()
