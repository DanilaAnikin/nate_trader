"""Per-account trading context for the multi-account agent.

An `AccountContext` bundles an account's identity with an Alpaca
`TradingClient` built from its Vault-stored credentials. `iter_account_contexts`
yields one context per active account — the basis for per-account isolation.
"""

from alpaca.trading.client import TradingClient

from supabase_client import get_account_credentials, get_active_accounts
from utils import setup_logging

log = setup_logging("accounts")


class AccountContext:
    """An active account plus its authenticated Alpaca client."""

    def __init__(self, row: dict, api_key: str, api_secret: str):
        self.row = row
        self.id = row["id"]
        self.mode = row["mode"]  # 'paper' | 'live'
        self.nickname = row.get("nickname", self.id)
        self.alpaca_account_number = row.get("alpaca_account_number")
        self.client = TradingClient(
            api_key, api_secret, paper=(self.mode == "paper")
        )

    def __repr__(self) -> str:
        return f"<AccountContext {self.nickname} ({self.mode})>"


def iter_account_contexts():
    """Yield an AccountContext for every active account.

    An account whose credentials cannot be decrypted is logged and skipped,
    so one broken account never blocks the rest.
    """
    for row in get_active_accounts():
        try:
            api_key, api_secret = get_account_credentials(row["id"])
        except Exception as exc:
            log.error(
                "skipping account %s — credentials unavailable: %s",
                row.get("nickname", row.get("id")),
                exc,
            )
            continue
        yield AccountContext(row, api_key, api_secret)
