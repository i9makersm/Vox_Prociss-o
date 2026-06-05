FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.html server.js ./
COPY assets ./assets

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["npm", "run", "start"]
