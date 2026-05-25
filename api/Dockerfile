# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Copy package configurations
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies including devDependencies for compiling TS
RUN npm ci

# Copy the application source code
COPY src/ ./src/

# Compile TypeScript to JavaScript
RUN npm run build

# Stage 2: Production runner
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

# Set production environment
ENV NODE_ENV=production

# Copy package configurations
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy built code from the builder stage
COPY --from=builder /usr/src/app/dist ./dist

# Create a non-root system user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /usr/src/app
USER appuser

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "dist/index.js"]
