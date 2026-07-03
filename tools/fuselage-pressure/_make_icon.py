# Generate the fuselage-pressure tool icon (1024x1024 PNG), matching the
# flat, simple icon style used across the site (see fuselage-cutout.png):
# no background grid, no baked-in title text, generous padding, flat fills,
# blue/orange accent palette.
import math
from PIL import Image, ImageDraw

W = H = 1024
TRANSPARENT = (0, 0, 0, 0)
FILL = (233, 240, 238, 255)     # pale blue-green fuselage fill
RING = (31, 86, 115, 255)       # blue ring / frame
LOAD = (194, 65, 12, 255)       # orange pressure arrows

img = Image.new("RGBA", (W, H), TRANSPARENT)
d = ImageDraw.Draw(img)

cx, cy = W/2, H/2
R = 300

# fuselage cross-section: filled circle with blue ring
d.ellipse([cx-R, cy-R, cx+R, cy+R], fill=FILL, outline=RING, width=16)

# frame cross (skin stiffeners), thinner blue lines through the circle
d.line([(cx-R, cy), (cx+R, cy)], fill=RING, width=10)
d.line([(cx, cy-R), (cx, cy+R)], fill=RING, width=10)

# radial pressure arrows, pushing outward through the skin (orange)
narrow = 8
for k in range(narrow):
    a = math.pi*2*k/narrow + math.pi/8
    x0 = cx + (R-110)*math.cos(a); y0 = cy + (R-110)*math.sin(a)
    x1 = cx + (R+55)*math.cos(a);  y1 = cy + (R+55)*math.sin(a)
    d.line([(x0, y0), (x1, y1)], fill=LOAD, width=16)
    ang = math.atan2(y1-y0, x1-x0)
    h = 34
    hx1 = x1 - h*math.cos(ang-0.45); hy1 = y1 - h*math.sin(ang-0.45)
    hx2 = x1 - h*math.cos(ang+0.45); hy2 = y1 - h*math.sin(ang+0.45)
    d.polygon([(x1, y1), (hx1, hy1), (hx2, hy2)], fill=LOAD)

img.save("_fuselage-pressure.png")
print("saved _fuselage-pressure.png", img.size)
