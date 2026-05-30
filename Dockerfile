# Use Python 3.11 slim image
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies needed for FAISS, PDF processing, etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first (better Docker layer caching)
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . .

# Create necessary directories for runtime
RUN mkdir -p vectors uploads knowledge_base temp_uploads

# Expose port 8080 (Fly.io default)
EXPOSE 8080

# Run the application with uvicorn on port 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]