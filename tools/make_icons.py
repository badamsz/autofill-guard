"""Render the toolbar icons (shield with a crossed-out text field)."""
import sys
from PIL import Image, ImageDraw
out = sys.argv[1]
S = 512
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
green = (46, 125, 50, 255)
# Shield
d.polygon([(256, 28), (456, 96), (456, 250), (420, 360), (256, 486), (92, 360), (56, 250), (56, 96)], fill=green)
# Text field
d.rounded_rectangle((126, 196, 386, 300), radius=22, fill=(255, 255, 255, 255))
# "typed" dots
for i, x in enumerate((166, 216, 266)):
    d.ellipse((x - 16, 232, x + 16, 264), fill=green)
# Slash
d.line((140, 380, 372, 128), fill=(255, 255, 255, 255), width=46)
d.line((140, 380, 372, 128), fill=(183, 28, 28, 255), width=26)
for size in (16, 32, 48, 128):
    img.resize((size, size), Image.LANCZOS).save(f"{out}/{size}.png")
