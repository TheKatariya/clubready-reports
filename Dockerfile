FROM mcr.microsoft.com/playwright/node:v1.59.1-jammy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY completed-classes.js ./

RUN mkdir -p /output
ENV DOWNLOAD_DIR=/output

CMD ["node", "-r", "dotenv/config", "completed-classes.js"]
