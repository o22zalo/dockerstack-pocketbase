FROM node:20-alpine

WORKDIR /app

COPY modules/consul-firebase /app/modules/consul-firebase
COPY services/consul-gateway/server.js /app/services/consul-gateway/server.js

EXPOSE 18090

CMD ["node", "/app/services/consul-gateway/server.js"]
