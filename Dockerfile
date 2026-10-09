FROM node:20-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
