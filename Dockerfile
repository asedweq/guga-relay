# For Fly.io / VPS / any Docker host. (Render uses npm directly, no Docker needed.)
FROM node:24-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --production=false

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm", "start"]
