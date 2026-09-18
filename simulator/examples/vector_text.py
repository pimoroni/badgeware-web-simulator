# The same rich-text layout, drawn with a scalable vector font loaded via
# font.load() so glyphs stay smooth at any size. [tags] still drive inline
# colour changes and images, and font_size is a point size rather than an
# integer scale.

import math

badge.mode(HIRES)

skull = image.load("/system/assets/skull.png")
add_sprite("skull", skull)
mona_sans = font.load("/system/assets/fonts/DynaPuff-Medium.af")


# A renderer is fn(image, params, measure): it returns its advance width when
# measuring, else draws at image.cursor and returns None.
def circle_glyph_renderer(image, _parameters, measure):
  if measure:
    return 12

  image.shape(shape.circle(image.cursor.x + 6, image.cursor.y + 7, 6))
  return None


add_glyph("circle", circle_glyph_renderer)


while True:
  screen.font = mona_sans
  screen.antialias = image.X2
  screen.alpha = 255

  size = (math.sin(badge.ticks / 1000) * 5) + 15
  message = """[pen:180,150,120]Upon the mast I gleam and grin, A sentinel of bone and sin. Wind and thunder, night and hull- None fear the sea like a [pen:230,220,200]pirate skull[pen:180,150,120].

[sprite:skull]

Once I roared with breath and [pen:255,100,80]flame[pen:180,150,120], Now legend is my only name. But still I guard the [pen:255,200,80]plundered gold[pen:180,150,120], Grinning wide, forever bold.
"""

  screen.pen = color.rgb(100, 255, 100, 150)

  x = 10
  y = 10
  width = math.sin(badge.ticks / 500) * 50 + 230
  height = 224
  bounds = rect(x, y, width, height)
  screen.text(message, bounds, font_size=size, line_height=1, word_spacing=1.05)

  screen.pen = color.rgb(60, 80, 100, 100)
  screen.line(bounds.x, bounds.y, bounds.x + bounds.w, bounds.y)
  screen.line(bounds.x, bounds.y, bounds.x, bounds.y + bounds.h)
  screen.line(bounds.x, bounds.y + bounds.h, bounds.x + bounds.w, bounds.y + bounds.h)
  screen.line(bounds.x + bounds.w, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h)
  badge.update()
