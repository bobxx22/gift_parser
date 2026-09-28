import json
import os
import requests
from PIL import Image
from io import BytesIO

# Настройки
JSON_FILE = 'data.json'
MAX_SIZE = (256, 256)          # максимальный размер
TIMEOUT = 15                   # таймаут запроса в секундах

# Создаём папку для всех коллекций, если её можно изменить
BASE_FOLDER = 'downloaded_collections'
os.makedirs(BASE_FOLDER, exist_ok=True)

# Читаем JSON
with open(JSON_FILE, 'r', encoding='utf-8') as f:
    data = json.load(f)

# Проходим по всем коллекциям
for collection_name, collection_data in data['collections'].items():
    folder_path = os.path.join(BASE_FOLDER, collection_name)
    os.makedirs(folder_path, exist_ok=True)
    
    print(f"Скачиваю коллекцию: {collection_name} → папка '{folder_path}'")
    
    for model in collection_data.get('models', []):
        url = model['url']
        name = model['name']
        
        # Формируем безопасное имя файла
        safe_name = "".join(c if c.isalnum() or c in " _-()" else "_" for c in name)
        filename = f"{safe_name}.png"
        filepath = os.path.join(folder_path, filename)
        
        try:
            # Скачиваем картинку
            response = requests.get(url, timeout=TIMEOUT)
            response.raise_for_status()
            
            # Открываем через PIL
            img = Image.open(BytesIO(response.content))
            
            # Изменяем размер: вписываем в 256x256 с сохранением пропорций
            img.thumbnail(MAX_SIZE, Image.Resampling.LANCZOS)
            
            # Если картинка меньше 256x256 — можно добавить белый фон (по желанию)
            # Раскомментируй ниже, если хочешь строго 256x256 с центрированием:
            """
            new_img = Image.new("RGB", MAX_SIZE, (255, 255, 255))  # белый фон
            offset = ((MAX_SIZE[0] - img.size[0]) // 2, (MAX_SIZE[1] - img.size[1]) // 2)
            new_img.paste(img, offset)
            img = new_img
            """
            
            # Сохраняем
            img.save(filepath, "PNG")
            print(f"    Saved: {filename}")
            
        except Exception as e:
            print(f"    Failed: {name} → {url} | Ошибка: {e}")

print("\nВсе картинки скачаны!")
