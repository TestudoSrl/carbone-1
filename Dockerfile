# Testudo fork of Carbone CE — minimal HTTP render service.
#
# Contract exposed on :4000 is a subset of Carbone Cloud/EE tailored to what
# the consumer's Carbone client modules actually call:
#
#   POST /render/template?download=true
#     { data, template: <base64>, convertTo, reportName, lang, timezone }
#   GET  /health
#
# LibreOffice is baked in for DOCX/ODT/XLSX → PDF conversion.

FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    CARBONE_PORT=4000 \
    CARBONE_TEMP_DIR=/app/tmp

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice \
      libreoffice-writer \
      libreoffice-calc \
      fonts-dejavu \
      fonts-liberation \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/* \
 # Carbone's LibreOffice discovery scans /opt/libreofficeN.N/program/ on Linux
 # and looks for `soffice.bin` in PATH — neither matches the Debian layout
 # (/usr/lib/libreoffice/program/soffice.bin, /usr/bin/soffice), so expose the
 # install under the expected /opt path using the major.minor version tag.
 && LO_VER=$(soffice --version | awk '{print $2}' | cut -d. -f1-2) \
 && ln -s /usr/lib/libreoffice "/opt/libreoffice${LO_VER}"

WORKDIR /app

# Install only production deps — tests and dev tooling aren't needed in the
# runtime image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Bundle the library + server + formatters.
COPY lib/        ./lib/
COPY formatters/ ./formatters/
COPY server/     ./server/
COPY bin/        ./bin/

RUN mkdir -p /app/tmp /app/tmp/render \
 && chown -R node:node /app
USER node

EXPOSE 4000

ENTRYPOINT ["tini", "--"]
CMD ["node", "server/server.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.CARBONE_PORT || 4000) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
