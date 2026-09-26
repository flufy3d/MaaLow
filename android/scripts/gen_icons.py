"""Generate the app icons, notification icon and web logo from mascot.png (run: uv run python android/scripts/gen_icons.py)."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
RES = ROOT / "android/app/src/main/res"
WEB = ROOT / "android/app/src/main/assets/web"
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
BG = "#FDFBF7"


def cutout(src: Image.Image) -> Image.Image:
    """The mascot on a transparent background: flood the near-white background in from the corners."""
    rgb = src.convert("RGB")
    w, h = rgb.size
    bg = rgb.getpixel((2, 2))
    px = rgb.load()
    near = lambda p: sum(abs(a - b) for a, b in zip(p, bg)) <= 10
    mask = Image.new("L", (w, h), 255)
    m = mask.load()
    stack = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    while stack:
        x, y = stack.pop()
        if m[x, y] == 0 or not near(px[x, y]):
            continue
        m[x, y] = 0
        if x > 0: stack.append((x - 1, y))
        if x < w - 1: stack.append((x + 1, y))
        if y > 0: stack.append((x, y - 1))
        if y < h - 1: stack.append((x, y + 1))
    out = rgb.convert("RGBA")
    out.putalpha(mask.filter(ImageFilter.MinFilter(7)).filter(ImageFilter.GaussianBlur(1.5)))  # shrink past the light fringe
    return out.crop(out.getbbox())


def ink(src: Image.Image) -> Image.Image:
    """White silhouette of the dark fur, for the notification and themed icons."""
    g = src.convert("L")
    alpha = g.point(lambda v: 255 if v < 90 else 0 if v > 160 else int((160 - v) * 255 / 70))
    out = Image.new("RGBA", src.size, (255, 255, 255, 0))
    out.putalpha(alpha)
    return out


def fit(img: Image.Image, size: int, frac: float, dy: float = 0) -> Image.Image:
    """img scaled so its longer side is frac of a size x size transparent canvas, centered."""
    s = frac * size / max(img.size)
    im = img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(im, ((size - im.width) // 2, (size - im.height) // 2 + round(dy * size)))
    return canvas


def main() -> None:
    mascot = cutout(Image.open(ROOT / "mascot.png"))
    silhouette = ink(mascot)
    for name, k in DENSITIES.items():
        d = RES / f"mipmap-{name}"
        d.mkdir(parents=True, exist_ok=True)
        fg = round(108 * k)  # adaptive layers: 108dp, the mascot inside the 66dp safe zone
        fit(mascot, fg, 0.60, 0.01).save(d / "ic_launcher_foreground.png")
        fit(silhouette, fg, 0.60, 0.01).save(d / "ic_launcher_monochrome.png")
        legacy = round(48 * k)  # pre-O launchers: a rounded square
        tile = Image.new("RGBA", (legacy, legacy), (0, 0, 0, 0))
        ImageDraw.Draw(tile).rounded_rectangle((0, 0, legacy - 1, legacy - 1), radius=legacy // 5, fill=BG)
        tile.alpha_composite(fit(mascot, legacy, 0.82))
        tile.save(d / "ic_launcher.png")
        n = RES / f"drawable-{name}"
        n.mkdir(parents=True, exist_ok=True)
        fit(silhouette, round(24 * k), 0.92).save(n / "ic_stat_maalow.png")
    nodpi = RES / "drawable-nodpi"
    nodpi.mkdir(parents=True, exist_ok=True)
    fit(mascot, 384, 1.0).save(nodpi / "mascot.png")
    WEB.mkdir(parents=True, exist_ok=True)
    fit(mascot, 256, 1.0).save(WEB / "mascot.png")
    fit(mascot, 64, 0.96).save(WEB / "favicon.png")


if __name__ == "__main__":
    main()
