FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json ./

# Copy all application files
COPY . .

# Default port
ENV PORT=5500
EXPOSE 5500

# Run server
CMD ["node", "server.js"]
