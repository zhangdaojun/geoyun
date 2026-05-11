import os
import sys
import tempfile
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../..')))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '../.env'))

from backend.app.services.oss_service import get_oss_bucket, is_oss_configured
from backend.app.services.pygimli_ert import run_pygimli_inversion

def test_oss_inversion():
    if not is_oss_configured():
        print("OSS not configured")
        return
        
    bucket = get_oss_bucket()
    test_key = "projects/PJ-2023-002/a32c4564bc3149e0a239e045fdaf303f/FS_2.dat"
    print(f"Downloading {test_key} from OSS...")
    
    with tempfile.TemporaryDirectory() as tmpdir:
        local_file = os.path.join(tmpdir, "test_data.dat")
        bucket.get_object_to_file(test_key, local_file)
        print(f"Downloaded to {local_file}, file size: {os.path.getsize(local_file)} bytes")
        
        output_dir = os.path.join(tmpdir, "inv_output")
        print("Running PyGIMLi Inversion...")
        try:
            result = run_pygimli_inversion(local_file, output_dir, max_iter=1)
            print("Inversion success! Result:")
            print(result)
            print("Output files:")
            for root, _, files in os.walk(output_dir):
                for file in files:
                    print(f"  - {file}")
        except Exception as e:
            print(f"Inversion failed: {e}")

if __name__ == "__main__":
    test_oss_inversion()
