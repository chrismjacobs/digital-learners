"""S3 media. Postgres stores keys only; binaries live in the bucket."""
import os
import mimetypes

import boto3
from botocore.exceptions import ClientError

MAX_BYTES = 15 * 1024 * 1024   # default cap (images); video/audio pass their own

IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
AUDIO_TYPES = {"audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/webm",
               "audio/ogg", "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac"}
VIDEO_TYPES = {"video/mp4", "video/webm", "video/ogg", "video/quicktime"}

_client = None


def client():
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            region_name=os.environ.get("AWS_S3_REGION"),
            aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
        )
    return _client


def bucket():
    return os.environ.get("AWS_S3_BUCKET")


def extension_for(filename, content_type):
    _, dot, ext = (filename or "").rpartition(".")
    if dot and 1 <= len(ext) <= 5 and ext.isalnum():
        return ext.lower()
    return (mimetypes.guess_extension(content_type or "") or ".bin").lstrip(".")


def put(file_storage, key, allowed_types, max_bytes=MAX_BYTES):
    """Upload a Werkzeug FileStorage. Raises ValueError on a rejected file."""
    content_type = (file_storage.mimetype or "").lower()
    if content_type not in allowed_types:
        raise ValueError(f"file type not allowed: {content_type or 'unknown'}")

    file_storage.stream.seek(0, os.SEEK_END)
    size = file_storage.stream.tell()
    file_storage.stream.seek(0)
    if size == 0:
        raise ValueError("file is empty")
    if size > max_bytes:
        raise ValueError(f"file is larger than {max_bytes // (1024 * 1024)}MB")

    client().upload_fileobj(
        file_storage.stream, bucket(), key,
        ExtraArgs={"ContentType": content_type},
    )
    return key


def signed_url(key, expires=3600):
    """Time-limited read URL for an S3 key. None passes through as None."""
    if not key:
        return None
    try:
        return client().generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket(), "Key": key},
            ExpiresIn=expires,
        )
    except ClientError:
        return None


def delete(key):
    if not key:
        return
    try:
        client().delete_object(Bucket=bucket(), Key=key)
    except ClientError:
        pass
