# Зависимостей у проекта нет, сборка не нужна — только рантайм Node.
# Node 22.5+ обязателен: используется встроенный модуль node:sqlite.
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_FILE=/data/store.db

WORKDIR /app

# Копируем только то, что нужно рантайму.
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts

# Каталог БД — отдельный том, чтобы состояние переживало пересоздание контейнера.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3000

# В образе нет curl/wget — проверяем своим же рантаймом.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
