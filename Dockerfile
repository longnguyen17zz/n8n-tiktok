FROM node:20-bookworm-slim

RUN apt-get update && \
    apt-get install -y ffmpeg gawk curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p temp logos

CMD ["node", "src/index.js"]
