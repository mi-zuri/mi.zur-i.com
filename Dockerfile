FROM node:22-slim
WORKDIR /app
COPY scripts/fetch-projects.mjs ./scripts/fetch-projects.mjs
ENTRYPOINT ["node", "scripts/fetch-projects.mjs"]
