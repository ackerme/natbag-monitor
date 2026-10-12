# ממסר השמע של שלוחה 5 – Node בלבד, בלי תלויות
FROM node:22-alpine
WORKDIR /app
COPY relay.mjs /app/relay.mjs
ENV NODE_ENV=production PORT=8000
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8000/healthz || exit 1
CMD ["node", "/app/relay.mjs"]
