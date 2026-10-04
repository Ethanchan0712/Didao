# 「的道」後端部署用 Dockerfile（Render 免費版）
# Node 22（同開發機一致）＋跳過無關 scripts ＋強制編譯數據庫組件（避免 139 崩潰）

FROM node:22-slim AS runtime
WORKDIR /app

# better-sqlite3 係原生模組，需要編譯工具
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm rebuild better-sqlite3 --build-from-source

# 前端靜態檔（Vite build 產出）——冇咗佢網頁版會 404
COPY dist ./dist

COPY server ./server

ENV PORT=10000
EXPOSE 10000
CMD ["node", "server/index.cjs"]
