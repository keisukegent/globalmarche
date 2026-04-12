from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


@dataclass
class DropboxSettings:
    statements_folder_template: str


@dataclass
class MatchingSettings:
    mode: str  # "naming" | "subfolder"
    subfolder_filename: str


@dataclass
class EmailTemplateSettings:
    subject_template: str
    body_template: str


@dataclass
class GmailSettings:
    send_as: str


@dataclass
class AppConfig:
    base_dir: Path
    dropbox: DropboxSettings
    owners_file: Path
    matching: MatchingSettings
    email: EmailTemplateSettings
    gmail: GmailSettings


def _load_yaml(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise ValueError("config.yaml のルートはマッピングである必要があります。")
    return data


def resolve_statements_folder(template: str, year: str, month: str) -> str:
    return template.format(year=year, month=month)


def load_config(config_path: Path) -> AppConfig:
    raw = _load_yaml(config_path)
    base_dir = config_path.parent.resolve()

    drop_raw = raw.get("dropbox") or {}
    folder_tpl = drop_raw.get("statements_folder_template") or drop_raw.get(
        "statements_folder"
    )
    if not folder_tpl:
        raise ValueError(
            "dropbox.statements_folder_template（または statements_folder）が必要です。"
        )

    owners_rel = raw.get("owners_file") or "owners.json"
    owners_file = (base_dir / owners_rel).resolve()

    match_raw = raw.get("matching") or {}
    mode = (match_raw.get("mode") or "naming").lower()
    if mode not in ("naming", "subfolder"):
        raise ValueError('matching.mode は "naming" または "subfolder" です。')
    subfolder_filename = match_raw.get("subfolder_filename") or "{year}-{month}.pdf"

    email_raw = raw.get("email") or {}
    subject_template = email_raw.get("subject_template") or ""
    body_template = email_raw.get("body_template") or ""
    if not subject_template or not body_template:
        raise ValueError("email.subject_template と email.body_template が必要です。")

    gmail_raw = raw.get("gmail") or {}
    send_as = gmail_raw.get("send_as") or ""
    if not send_as:
        raise ValueError("gmail.send_as（差出人メール）が必要です。")

    return AppConfig(
        base_dir=base_dir,
        dropbox=DropboxSettings(statements_folder_template=str(folder_tpl)),
        owners_file=owners_file,
        matching=MatchingSettings(mode=mode, subfolder_filename=subfolder_filename),
        email=EmailTemplateSettings(
            subject_template=subject_template,
            body_template=body_template,
        ),
        gmail=GmailSettings(send_as=send_as),
    )


def load_owners(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError("owners ファイルは JSON 配列である必要があります。")
    out: list[dict[str, Any]] = []
    for row in data:
        if not isinstance(row, dict):
            continue
        oid = row.get("owner_id")
        email = row.get("email")
        if not oid or not email:
            raise ValueError("各オーナーに owner_id と email が必要です。")
        out.append(row)
    return out


def load_dropbox_token() -> str:
    token = os.environ.get("DROPBOX_ACCESS_TOKEN", "").strip()
    if not token:
        raise RuntimeError(
            "環境変数 DROPBOX_ACCESS_TOKEN が未設定です。.env を参照してください。"
        )
    return token
