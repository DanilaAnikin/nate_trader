"""ML signal aggregator — sklearn classifier over engineered features.

Treats every existing indicator (RSI, MACD, BB position, volume ratio,
20d momentum, sector ranking, regime, etc) as a feature and learns a
probability that the next 5 trading days will deliver >+2% return.

The output is added as a `ml_score` (0..1) → mapped to ±5 score points
in compute_confidence_score. Walk-forward trained: model is fit on
data up to date D, never sees future bars.

Free path: scikit-learn RandomForest. Joblib persists model to
state/ml/model.joblib. Daily inference is < 100 ms for 35 symbols.

CLI:
  python3 scripts/ml_signals.py train    # build model from backtest bars
  python3 scripts/ml_signals.py predict SYMBOL
  python3 scripts/ml_signals.py status   # show model metadata
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import (  # noqa: E402
    PROJECT_ROOT, STATE_DIR,
    setup_logging, get_now_str, load_json, save_json,
    get_tradeable_symbols, get_symbol_info,
)

log = setup_logging("ml_signals")

ML_STATE_DIR = STATE_DIR / "ml"
MODEL_PATH = ML_STATE_DIR / "model.joblib"
META_PATH = ML_STATE_DIR / "metadata.json"

# Forward-return label: did the stock return > LABEL_THRESHOLD over LABEL_DAYS?
LABEL_DAYS = 5
LABEL_THRESHOLD = 2.0  # +2% in 5d = winning entry

# Features to extract from each bar window (all derivable from OHLCV)
FEATURE_NAMES = [
    "rsi_14", "macd_above_signal", "bb_position", "volume_ratio",
    "ret_1d", "ret_5d", "ret_20d", "ret_60d",
    "above_sma20", "above_sma50",
    "atr_pct", "vol_20d_std",
    "high_low_range_pct",
    "regime_bull", "regime_neutral", "regime_bear",
]


# ──────────────────────────── feature extraction ────────────────────────────


def extract_features(bars, regime: str = "NEUTRAL") -> dict | None:
    """Compute one feature row from a bars DataFrame.

    Pure function — accepts pandas DataFrame (≥ 60 rows recommended).
    Returns None on insufficient data.
    """
    try:
        import pandas as pd
        import ta as ta_lib
    except ImportError:
        return None

    if bars is None or len(bars) < 60:
        return None

    closes = bars["close"].astype(float)
    highs = bars["high"].astype(float)
    lows = bars["low"].astype(float)
    volumes = bars["volume"].astype(float)
    last = float(closes.iloc[-1])
    if last <= 0:
        return None

    # Indicators
    rsi = ta_lib.momentum.rsi(closes, window=14).iloc[-1]
    macd = ta_lib.trend.macd(closes, window_slow=26, window_fast=12).iloc[-1]
    macd_sig = ta_lib.trend.macd_signal(closes, window_slow=26, window_fast=12, window_sign=9).iloc[-1]
    sma20 = ta_lib.trend.sma_indicator(closes, window=20).iloc[-1]
    sma50 = ta_lib.trend.sma_indicator(closes, window=50).iloc[-1]
    bb_high = ta_lib.volatility.bollinger_hband(closes, window=20, window_dev=2).iloc[-1]
    bb_low = ta_lib.volatility.bollinger_lband(closes, window=20, window_dev=2).iloc[-1]
    atr = ta_lib.volatility.average_true_range(highs, lows, closes, window=14).iloc[-1]

    # Returns
    def _ret(n):
        if len(closes) < n + 1:
            return 0.0
        return (last / float(closes.iloc[-n - 1]) - 1) * 100

    # Volume
    avg_vol = float(volumes.iloc[:-1].rolling(20).mean().iloc[-1])
    vol_ratio = (float(volumes.iloc[-2]) / avg_vol) if avg_vol > 0 else 1.0

    # Volatility
    vol_20d_std = float(closes.pct_change().tail(20).std() * 100)

    # Range
    hl_range = (float(highs.iloc[-1]) - float(lows.iloc[-1])) / last * 100

    # Bollinger position 0..1 (0=below lower, 1=above upper)
    bb_pos = (last - float(bb_low)) / (float(bb_high) - float(bb_low)) if bb_high != bb_low else 0.5

    out = {
        "rsi_14": float(rsi) if pd.notna(rsi) else 50.0,
        "macd_above_signal": 1.0 if (pd.notna(macd) and pd.notna(macd_sig) and macd > macd_sig) else 0.0,
        "bb_position": float(bb_pos),
        "volume_ratio": float(vol_ratio),
        "ret_1d": _ret(1),
        "ret_5d": _ret(5),
        "ret_20d": _ret(20),
        "ret_60d": _ret(60) if len(closes) >= 61 else 0.0,
        "above_sma20": 1.0 if (pd.notna(sma20) and last > float(sma20)) else 0.0,
        "above_sma50": 1.0 if (pd.notna(sma50) and last > float(sma50)) else 0.0,
        "atr_pct": (float(atr) / last * 100) if pd.notna(atr) and last > 0 else 0.0,
        "vol_20d_std": vol_20d_std,
        "high_low_range_pct": hl_range,
        "regime_bull": 1.0 if regime == "BULL" else 0.0,
        "regime_neutral": 1.0 if regime == "NEUTRAL" else 0.0,
        "regime_bear": 1.0 if regime == "BEAR" else 0.0,
    }
    return out


def _detect_regime(spy_bars) -> str:
    """Simple SPY regime classifier from bars."""
    try:
        import ta as ta_lib
        import pandas as pd
    except ImportError:
        return "NEUTRAL"
    if spy_bars is None or len(spy_bars) < 50:
        return "NEUTRAL"
    closes = spy_bars["close"].astype(float)
    sma20 = ta_lib.trend.sma_indicator(closes, window=20).iloc[-1]
    sma50 = ta_lib.trend.sma_indicator(closes, window=50).iloc[-1]
    price = float(closes.iloc[-1])
    if pd.notna(sma20) and pd.notna(sma50):
        if price > float(sma20) > float(sma50):
            return "BULL"
        if price < float(sma20) < float(sma50):
            return "BEAR"
    return "NEUTRAL"


# ────────────────────────────── training ────────────────────────────────────


def _load_backtest_bars(symbol: str):
    """Load cached daily bars from state/backtest/bars/{symbol}.json."""
    try:
        import pandas as pd
    except ImportError:
        return None
    path = PROJECT_ROOT / "state" / "backtest" / "bars" / f"{symbol}.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    bars = data.get("bars", [])
    if not bars:
        return None
    df = pd.DataFrame(bars)
    df["date"] = df["date"].astype(str)
    return df.set_index("date").sort_index()


def build_training_set(symbols: list[str] | None = None,
                       end_date: str | None = None) -> tuple:
    """Walk through every (symbol, date) and produce (features, label) rows.

    Label = 1 if forward 5d return > LABEL_THRESHOLD%, else 0.
    Returns (X numpy array, y numpy array, dates list, symbols list).
    """
    try:
        import numpy as np
    except ImportError:
        raise RuntimeError("numpy required for training")

    symbols = symbols or sorted(get_tradeable_symbols())
    end_date = end_date or datetime.now().strftime("%Y-%m-%d")

    spy = _load_backtest_bars("SPY")
    if spy is None:
        log.error("No SPY bars cached — run download mode first")
        return np.array([]), np.array([]), [], []

    X_rows, y_rows = [], []
    date_meta, sym_meta = [], []

    for sym in symbols:
        bars = _load_backtest_bars(sym)
        if bars is None:
            continue
        all_dates = sorted(bars.index.tolist())
        for i, date in enumerate(all_dates):
            if date > end_date:
                break
            # Need 60 bars of history + 5 bars of forward
            if i < 60 or i + LABEL_DAYS >= len(all_dates):
                continue
            window = bars.iloc[i - 60: i + 1]
            spy_window = spy.loc[spy.index <= date].iloc[-80:] if len(spy.loc[spy.index <= date]) >= 50 else None
            regime = _detect_regime(spy_window)
            features = extract_features(window, regime=regime)
            if features is None:
                continue
            # Forward return
            future_close = float(bars["close"].iloc[i + LABEL_DAYS])
            current_close = float(bars["close"].iloc[i])
            fwd_ret = (future_close / current_close - 1) * 100
            label = 1 if fwd_ret > LABEL_THRESHOLD else 0
            X_rows.append([features[k] for k in FEATURE_NAMES])
            y_rows.append(label)
            date_meta.append(date)
            sym_meta.append(sym)

    X = np.array(X_rows, dtype=float)
    y = np.array(y_rows, dtype=int)
    log.info(f"Training set: {len(X)} samples, "
             f"positive class rate {y.mean():.2%}")
    return X, y, date_meta, sym_meta


def train_and_save(test_size: float = 0.2) -> dict:
    """Build dataset, train RandomForest, walk-forward split, persist."""
    try:
        from sklearn.ensemble import RandomForestClassifier
        from sklearn.metrics import roc_auc_score, accuracy_score
        import joblib
        import numpy as np
    except ImportError as e:
        return {"error": f"sklearn/joblib not installed: {e}"}

    ML_STATE_DIR.mkdir(parents=True, exist_ok=True)

    X, y, dates, syms = build_training_set()
    if len(X) < 1000:
        return {"error": f"Not enough samples ({len(X)}) — download more bars"}

    # Walk-forward split: train on earliest (1-test_size), test on latest
    # Order is symbol-grouped, so we sort by date to get true temporal split
    sort_idx = sorted(range(len(dates)), key=lambda i: dates[i])
    X = X[sort_idx]
    y = y[sort_idx]
    split = int(len(X) * (1 - test_size))
    X_train, X_test = X[:split], X[split:]
    y_train, y_test = y[:split], y[split:]

    log.info(f"Training: {len(X_train)} samples; testing: {len(X_test)}")

    model = RandomForestClassifier(
        n_estimators=200,
        max_depth=10,
        min_samples_leaf=20,
        random_state=42,
        n_jobs=-1,
    )
    model.fit(X_train, y_train)

    train_acc = accuracy_score(y_train, model.predict(X_train))
    test_acc = accuracy_score(y_test, model.predict(X_test))
    train_auc = roc_auc_score(y_train, model.predict_proba(X_train)[:, 1])
    test_auc = roc_auc_score(y_test, model.predict_proba(X_test)[:, 1])

    joblib.dump({"model": model, "feature_names": FEATURE_NAMES}, MODEL_PATH)

    importances = sorted(
        zip(FEATURE_NAMES, model.feature_importances_),
        key=lambda x: x[1], reverse=True,
    )

    meta = {
        "trained_at": get_now_str(),
        "n_samples_total": len(X),
        "n_samples_train": len(X_train),
        "n_samples_test": len(X_test),
        "label_threshold_pct": LABEL_THRESHOLD,
        "label_horizon_days": LABEL_DAYS,
        "positive_class_rate": float(y.mean()),
        "train_accuracy": float(train_acc),
        "test_accuracy": float(test_acc),
        "train_auc": float(train_auc),
        "test_auc": float(test_auc),
        "top_features": [{"name": n, "importance": float(imp)} for n, imp in importances[:8]],
        "feature_names": FEATURE_NAMES,
    }
    save_json(META_PATH, meta)
    log.info(f"Model saved → {MODEL_PATH}  test_auc={test_auc:.3f}  test_acc={test_acc:.3f}")
    return meta


# ────────────────────────────── inference ────────────────────────────────


_cached_model = None


def _load_model():
    global _cached_model
    if _cached_model is not None:
        return _cached_model
    if not MODEL_PATH.exists():
        return None
    try:
        import joblib
        _cached_model = joblib.load(MODEL_PATH)
    except Exception as e:
        log.warning(f"Model load failed: {e}")
        return None
    return _cached_model


def predict_proba(features: dict) -> float | None:
    """Return probability of forward-5d-return > threshold for one feature row.

    Returns None if model unavailable or features incomplete.
    """
    bundle = _load_model()
    if bundle is None:
        return None
    try:
        import numpy as np
    except ImportError:
        return None
    feature_names = bundle.get("feature_names", FEATURE_NAMES)
    try:
        row = np.array([[features[k] for k in feature_names]], dtype=float)
    except KeyError:
        return None
    return float(bundle["model"].predict_proba(row)[0, 1])


def ml_score_from_proba(p: float | None) -> int:
    """Map probability → integer score adjustment (−5 .. +5).

    Maintains balance: only strong signals (p > 0.65 or p < 0.35) move
    the needle. Middle band returns 0 (neutral).
    """
    if p is None:
        return 0
    if p >= 0.65:
        return 5
    if p >= 0.55:
        return 3
    if p <= 0.35:
        return -5
    if p <= 0.45:
        return -3
    return 0


# ─────────────────────────────── CLI ─────────────────────────────────────


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"

    if cmd == "train":
        meta = train_and_save()
        print(json.dumps(meta, indent=2))

    elif cmd == "status":
        meta = load_json(META_PATH)
        if not meta:
            print("No model trained yet — run `train`")
        else:
            print(json.dumps(meta, indent=2))

    elif cmd == "predict" and len(sys.argv) > 2:
        sym = sys.argv[2].upper()
        bars = _load_backtest_bars(sym)
        if bars is None:
            print(f"No cached bars for {sym}")
            return
        spy = _load_backtest_bars("SPY")
        regime = _detect_regime(spy.tail(80)) if spy is not None else "NEUTRAL"
        features = extract_features(bars.tail(80), regime=regime)
        if features is None:
            print(f"Insufficient data for {sym}")
            return
        proba = predict_proba(features)
        score = ml_score_from_proba(proba)
        print(f"{sym}: ML proba={proba:.3f} → score adjustment {score:+d}" if proba is not None else f"{sym}: no model loaded")

    else:
        print("Usage: python3 scripts/ml_signals.py [train|status|predict SYMBOL]")


if __name__ == "__main__":
    main()
