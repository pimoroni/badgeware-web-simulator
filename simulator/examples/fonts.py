# Badgeware has built-in ROM pixel fonts (rom_font.*) and can load scalable
# vector fonts from .af files with font.load(). Set screen.font before drawing.

badge.mode(HIRES)

# Vector fonts are loaded once at startup.
big = font.load("/system/assets/fonts/DynaPuff-Medium.af")

rom_names = ["sins", "hungry", "fear", "winds"]

while True:
    # Each ROM font is a fixed pixel style.
    for i, name in enumerate(rom_names):
        screen.font = getattr(rom_font, name)
        screen.pen = color.white
        screen.text(name + " 12345", 10, 20 + i * 22)

    # A vector font scales smoothly — pass the size as a 4th argument.
    screen.font = big
    screen.antialias = image.X2
    screen.pen = color.yellow
    screen.text("Vector!", 10, 150, 48)

    badge.update()
