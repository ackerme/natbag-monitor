# natbag-exporter – נבנה מתיקיית השורש של ה-repo (context: ../..), כדי להשתמש באותו flights.mjs של השרת
FROM node:22-alpine
WORKDIR /app
COPY natbag-aws/src/proxy/flights.mjs /app/flights.mjs
COPY ops/monitoring/exporter/exporter.mjs /app/exporter.mjs
ENV FLIGHTS_MODULE=/app/flights.mjs PORT=9877 NODE_ENV=production
# בלי הרשאות root
USER node
EXPOSE 9877
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:9877/healthz || exit 1
CMD ["node", "/app/exporter.mjs"]
