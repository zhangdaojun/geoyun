import re
from typing import Any, Dict

from sqlalchemy.orm import Session

from ..models import FileRecord, Project


def auto_match_project_files(db: Session, project: Project) -> Dict[str, Any]:
    """
    后端的自动匹配算法：
    将项目中的文件基于文件名和测点编号进行匹配，
    更新对应 SurveyPoint 的 matched_file_ids_json 和 matched_data_paths_json。
    """
    
    # 1. 提取所有需要匹配的文件（非目录）
    files = (
        db.query(FileRecord)
        .filter(
            FileRecord.owner_id == project.id,
            FileRecord.status != "deleted",
            FileRecord.owner_type == "project",
        )
        .all()
    )
    
    # 过滤掉非数据文件，可根据业务实际扩展后缀列表
    valid_exts = {"edi", "mtts", "ts", "tbl", "stn", "avg", "r", "psd", "fh", "fm", "fl"}
    data_files = [
        f for f in files
        if (f.file_ext and f.file_ext.lower().lstrip(".") in valid_exts)
        or (
            "." in str(f.file_name or "")
            and str(f.file_name or "").rsplit(".", 1)[-1].lower() in valid_exts
        )
    ]
    
    match_count = 0
    
    # 2. 遍历测线和测点
    for line in project.survey_lines:
        for point in line.survey_points:
            # 构建正则模式以匹配文件名中包含点号的情况
            # 比如测点是 P100 或 100，尝试在文件名里找
            point_code = str(point.point_code).strip()
            
            # 简单的特征码提取：如果是 P100 提取 100
            num_match = re.search(r'\d+', point_code)
            tokens = [point_code]
            if num_match:
                tokens.append(num_match.group())
            
            # 去重
            tokens = list(set(tokens))
            
            matched_files = []
            
            for f in data_files:
                name = f.file_name or ""
                # 如果文件名中包含这些 token 的任何一个，且包含测线名（可选，增强精确度）
                # 这里做最基础的匹配，实际业务中可加入更复杂的规则
                for token in tokens:
                    # 使用 \b 边界匹配避免 10 匹配到 100
                    pattern = r'\b' + re.escape(token) + r'\b'
                    if re.search(pattern, name, re.IGNORECASE):
                        matched_files.append(f)
                        break
            
            # 如果匹配到了文件，更新测点状态
            if matched_files:
                point.matched_file_ids_json = [f.id for f in matched_files]
                point.matched_data_paths_json = [f.object_key for f in matched_files]
                point.matched_data_count = len(matched_files)
                point.point_status = "matched"
                match_count += len(matched_files)
            else:
                # 尝试保留旧的逻辑状态，或重置
                if not point.matched_file_ids_json and not point.matched_data_paths_json:
                    point.point_status = "pending"
                    point.matched_data_count = 0
    
    db.commit()
    return {"status": "success", "matched_files_count": match_count}
