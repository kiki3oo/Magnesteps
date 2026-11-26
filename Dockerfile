FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY . .

# Customer orders live in a persistent volume (mount /app/data in Easypanel)
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV DATA_DIR=/app/data
VOLUME ["/app/data"]

ENV PORT=5500
EXPOSE 5500

# Do not run as root
USER node

# Required env vars: ADMIN_PASSWORD, SANADOKOM_WEBHOOK_SECRET
CMD ["node", "server.js"]
