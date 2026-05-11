import base64
import hashlib
import hmac
import json
import time
from datetime import datetime
from typing import Dict, Any

import oss2

from ..config import get_settings

settings = get_settings()

def is_oss_configured() -> bool:
    """检查是否配置了阿里云 OSS"""
    return bool(
        settings.oss_access_key_id 
        and settings.oss_access_key_secret 
        and settings.oss_endpoint 
        and settings.oss_bucket_name
    )

def get_oss_bucket() -> oss2.Bucket:
    """获取 OSS Bucket 对象"""
    auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
    bucket = oss2.Bucket(auth, settings.oss_endpoint, settings.oss_bucket_name)
    return bucket


def get_object_size(object_key: str) -> int:
    if not object_key or not is_oss_configured():
        return 0
    try:
        headers = get_oss_bucket().head_object(object_key)
        return max(int(headers.content_length or 0), 0)
    except Exception:
        return 0


def find_object_key_by_name(prefix: str, file_name: str, expected_size: int = 0) -> str:
    if not prefix or not file_name or not is_oss_configured():
        return ""
    expected_name = str(file_name).strip()
    expected_suffix = f"/{expected_name}"
    try:
      for obj in oss2.ObjectIterator(get_oss_bucket(), prefix=prefix):
          if obj.key == f"{prefix.rstrip('/')}/{expected_name}" or obj.key.endswith(expected_suffix):
              if expected_size and int(obj.size or 0) != int(expected_size):
                  continue
              return obj.key
    except Exception:
        return ""
    return ""

def generate_post_policy(object_key: str, expire_minutes: int = 15) -> Dict[str, Any]:
    """
    生成前端直传阿里云 OSS 所需的 Post Policy 签名
    """
    now = int(time.time())
    expire_syncpoint = now + expire_minutes * 60
    # 格式化为 ISO8601 UTC 时间
    expire_date = datetime.utcfromtimestamp(expire_syncpoint).strftime('%Y-%m-%dT%H:%M:%S.000Z')

    # 构建 Policy 字典
    policy_dict = {
        "expiration": expire_date,
        "conditions": [
            # 限制上传的 Bucket
            ["eq", "$bucket", settings.oss_bucket_name],
            # 限制上传路径前缀
            ["starts-with", "$key", object_key],
            # 限制文件大小 0-10GB (10 * 1024 * 1024 * 1024)
            ["content-length-range", 0, 10737418240]
        ]
    }
    
    # 转换为 JSON 并 Base64 编码
    policy_json = json.dumps(policy_dict).strip()
    policy_base64 = base64.b64encode(policy_json.encode()).decode()

    # 使用 AccessKeySecret 对 Policy 进行 HMAC-SHA1 签名
    h = hmac.new(
        settings.oss_access_key_secret.encode('utf-8'),
        policy_base64.encode('utf-8'),
        hashlib.sha1
    )
    signature = base64.b64encode(h.digest()).decode()

    # 确定 Host，例如: https://geoyun-drive.oss-cn-hangzhou.aliyuncs.com
    # 如果 endpoint 没有包含 http，我们拼接一下
    endpoint = settings.oss_endpoint
    if endpoint.startswith("http://") or endpoint.startswith("https://"):
        host = endpoint.replace("://", f"://{settings.oss_bucket_name}.")
    else:
        host = f"https://{settings.oss_bucket_name}.{endpoint}"

    return {
        "accessid": settings.oss_access_key_id,
        "host": host,
        "policy": policy_base64,
        "signature": signature,
        "expire": expire_syncpoint,
        "dir": object_key
    }

def generate_download_url(object_key: str, expire_minutes: int = 60) -> str:
    """
    生成带有签名和有效期的下载链接
    """
    bucket = get_oss_bucket()
    # sign_url 默认返回 http 协议，实际可配置 endpoint 带 https
    url = bucket.sign_url('GET', object_key, expire_minutes * 60)
    # 如果原始 endpoint 配置了 https，这里可以强转替换（oss2 SDK 可能默认返回 http）
    if settings.oss_endpoint.startswith("https://") and url.startswith("http://"):
        url = url.replace("http://", "https://", 1)
    elif not url.startswith("http"):
        url = f"https://{url}"
    return url
