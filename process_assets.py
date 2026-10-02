from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

SOURCES = [
    "/home/ubuntu/attachments/48c5282e-8750-4e82-8dc6-954f203b7aa7/IMG_1267.PNG",
    "/home/ubuntu/attachments/6de121b8-9dd6-437a-9304-bd991c9218c8/IMG_1268.PNG",
    "/home/ubuntu/attachments/a5a77498-b570-4b70-9dac-26d419113bf3/IMG_1269.PNG",
    "/home/ubuntu/attachments/752519d6-069e-4487-b5da-24f2aaabffee/IMG_1270.PNG",
    "/home/ubuntu/attachments/62415dc3-9df7-425c-bfa2-f12782370b63/IMG_1271.PNG",
    "/home/ubuntu/attachments/9abb6cd9-2e68-4acb-a653-cd323f49c77f/IMG_1272.PNG",
    "/home/ubuntu/attachments/2fcbfae4-769c-46db-ab92-e7115cdacabd/IMG_1273.PNG",
    "/home/ubuntu/attachments/3f499db0-8e1c-44fc-875c-2cfcb642cf31/IMG_1274.PNG",
    "/home/ubuntu/attachments/c88d52ee-1e64-4535-b98c-b4ccf05cbd30/IMG_1275.PNG",
    "/home/ubuntu/attachments/a24d7199-fbee-4c08-b706-5376d789b549/IMG_1276.PNG",
    "/home/ubuntu/attachments/f28b10df-1e7f-4dca-94d5-702a54a42f37/IMG_1277.PNG",
    "/home/ubuntu/attachments/32823eea-c4a7-45e4-b1ed-50c04477e9d5/IMG_1278.PNG",
]

OUT = Path(__file__).resolve().parent / "public/tenants/michael-heckert/processed"
OUT.mkdir(parents=True, exist_ok=True)

for index, source in enumerate(SOURCES):
    image = Image.open(source).convert("RGB")
    preview = np.asarray(image.resize((120, 260)))
    brightness = preview.mean(axis=2)
    active_rows = np.where((brightness > 7).mean(axis=1) > 0.35)[0]
    if active_rows.size:
        scale = image.height / preview.shape[0]
        top = max(0, int(active_rows[0] * scale) - 8)
        bottom = min(image.height, int((active_rows[-1] + 1) * scale) + 8)
        image = image.crop((0, top, image.width, bottom))

    target_width = 900
    target_height = round(image.height * target_width / image.width)
    image = image.resize((target_width, target_height), Image.Resampling.LANCZOS)
    image = ImageEnhance.Contrast(image).enhance(1.04)
    image = ImageEnhance.Color(image).enhance(0.92)
    image = image.filter(ImageFilter.UnsharpMask(radius=1.2, percent=75, threshold=4))
    image.save(OUT / f"heckert-{index:02d}.webp", "WEBP", quality=84, method=6)

print(f"Created {len(SOURCES)} optimized 360 frames in {OUT}")
