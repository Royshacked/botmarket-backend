# A MODEL ON THE RUN-UP, AND RULES COMBINED -- test K (screener-lab.md section 27, declared before the run).
# Reads the table scripts/lab-runup-ml.mjs writes (every run-up entry, its facts, its net vs SPY after cost).
#
#   python scripts/lab-runup-ml.py data/lab/runup-ml.csv [--shuffles=20] [--no-combos]
#
# Part 1, THE MODEL: LightGBM (one setting, not tuned) and a logistic regression; walk-forward 2021..2025, then the
# held-out year (entries from 2025-10-23). Part 2, RULES COMBINED: singles, pairs and triples of tertile conditions,
# chosen on the years before the held-out day, a luck check by shuffling the nets within each session.
import sys
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

SPLIT, MID, BLOCK = '2025-10-23', '2022-10-23', 5
FOLDS = [2021, 2022, 2023, 2024, 2025]
PARAMS = dict(objective='binary', n_estimators=300, learning_rate=0.03, num_leaves=15, min_child_samples=200,
              colsample_bytree=0.8, reg_lambda=1.0, verbose=-1, random_state=7)
MIN_TRADES, MIN_SESSIONS = 300, 100

args = sys.argv[1:]
path = next(a for a in args if not a.startswith('--'))
opt = {a.split('=')[0][2:]: (a.split('=') + [True])[1] for a in args if a.startswith('--')}
SHUFFLES = int(opt.get('shuffles', 20))

df = pd.read_csv(path)
days = [d.strip() for d in open(path.replace('.csv', '.days.txt')) if d.strip()]
FEATS = list(df.columns[7:])
df['y'] = (df.net > 0).astype(int)
day_pos = {d: k for k, d in enumerate(days)}
df['dk'] = df.day.map(day_pos)
assert df.dk.notna().all()


def per_session(net, dk):
    """Each session once: the mean of the sessions' mean nets."""
    if len(net) == 0:
        return np.nan
    s = np.bincount(dk, weights=net, minlength=len(days)); c = np.bincount(dk, minlength=len(days))
    return float((s[c > 0] / c[c > 0]).mean())


def block_range(net, dk):
    """screenerLab blockRange: the calendar cut in blocks of BLOCK sessions, a block's mean the mean of its sessions'."""
    s = np.bincount(dk, weights=net, minlength=len(days)); c = np.bincount(dk, minlength=len(days))
    has = c > 0
    if not has.any():
        return (np.nan, np.nan, 0)
    dm = s[has] / c[has]; b = np.nonzero(has)[0] // BLOCK
    bm = np.bincount(b, weights=dm) [np.bincount(b) > 0] / np.bincount(b)[np.bincount(b) > 0]
    if len(bm) < 3:
        return (np.nan, np.nan, len(bm))
    m, se = bm.mean(), bm.std(ddof=1) / np.sqrt(len(bm))
    return (m - 1.96 * se, m + 1.96 * se, len(bm))


def f(x):
    return '   -   ' if x is None or not np.isfinite(x) else f'{x:+.2f}%'.rjust(7)


def line(label, sub):
    lo, hi, _ = block_range(sub.net.values, sub.dk.values)
    return (f'  {label:<34} {len(sub):>6} trades {sub.day.nunique():>4} sessions  per session {f(per_session(sub.net.values, sub.dk.values))}'
            f'  blocks {f(lo)} .. {f(hi)}  up {sub.y.mean() * 100 if len(sub) else 0:4.0f}%')


# ---------------------------------------------------------------------------------------------- PART 1: THE MODEL
def fit_score(train, test):
    m = lgb.LGBMClassifier(**PARAMS).fit(train[FEATS], train.y)
    # The logistic: standardized on the train, a missing value is its mean, clipped at 4 sd (as moverDiff fitAndScore).
    mu, sd = train[FEATS].mean(), train[FEATS].std().replace(0, 1).fillna(1)
    z = lambda d: ((d[FEATS] - mu) / sd).fillna(0).clip(-4, 4)
    lr = LogisticRegression(C=1.0, max_iter=2000).fit(z(train), train.y)
    return m, m.predict_proba(test[FEATS])[:, 1], lr.predict_proba(z(test))[:, 1]


def thirds(test, score):
    r = pd.Series(score, index=test.index).rank(method='first') / len(test)
    return test[r <= 1 / 3], test[(r > 1 / 3) & (r <= 2 / 3)], test[r > 2 / 3]


print(f'{len(df)} run-up trades {df.day.min()} -> {df.day.max()} | live rule {df.live.sum()} | {len(FEATS)} facts')
print('\n== PART 1 - THE MODEL (LightGBM, one setting) ==')
oof_y, oof_s, oof_l, wins_auc, wins_top = [], [], [], 0, 0
for y in FOLDS:
    start, end = f'{y}-01-01', min(f'{y + 1}-01-01', SPLIT)
    train, test = df[df.exit_day < start], df[(df.day >= start) & (df.day < end)]
    _, s, l = fit_score(train, test)
    auc, lauc = roc_auc_score(test.y, s), roc_auc_score(test.y, l)
    lo, mid, hi = thirds(test, s)
    top, bot = per_session(hi.net.values, hi.dk.values), per_session(lo.net.values, lo.dk.values)
    wins_auc += auc > 0.5; wins_top += top > bot
    oof_y += list(test.y); oof_s += list(s); oof_l += list(l)
    print(f'\n{y}: fitted on {len(train)}, scored {len(test)} | AUC {auc:.3f} (logistic {lauc:.3f})')
    print(line('every run-up trade', test)); print(line('model bottom third', lo)); print(line('model middle third', mid))
    print(line('model TOP third', hi)); print(line('live rule', test[test.live == 1]))
pooled, lpooled = roc_auc_score(oof_y, oof_s), roc_auc_score(oof_y, oof_l)
print(f'\nwalk-forward pooled AUC {pooled:.3f} (logistic {lpooled:.3f}) | AUC > 0.5 in {wins_auc}/5 | top > bottom in {wins_top}/5')

train, test = df[df.exit_day < SPLIT], df[df.day >= SPLIT]
model, s, l = fit_score(train, test)
lo, mid, hi = thirds(test, s)
live = test[test.live == 1]
print(f'\nHELD OUT (from {SPLIT}): fitted on {len(train)}, scored {len(test)} | AUC {roc_auc_score(test.y, s):.3f} (logistic {roc_auc_score(test.y, l):.3f})')
for label, sub in [('every run-up trade', test), ('model bottom third', lo), ('model middle third', mid), ('model TOP third', hi), ('live rule', live)]:
    print(line(label, sub))
ls = pd.Series(s, index=test.index)[live.index]
lr_ = ls.rank(method='first') / len(ls)
print(line('live rule x model top half', live[lr_ > 0.5])); print(line('live rule x model bottom half', live[lr_ <= 0.5]))
imp = pd.Series(model.booster_.feature_importance('gain'), index=FEATS).sort_values(ascending=False)
print('  facts by gain (held-out model): ' + ', '.join(f'{k} {v / imp.sum() * 100:.0f}%' for k, v in imp.head(10).items()))
top_ps, top_lo = per_session(hi.net.values, hi.dk.values), block_range(hi.net.values, hi.dk.values)[0]
p1 = (pooled >= 0.53 and wins_auc >= 4 and wins_top >= 4 and top_ps > per_session(test.net.values, test.dk.values)
      and top_ps > per_session(live.net.values, live.dk.values) and top_lo > 0)
print(f'\nDECLARED (model): pooled AUC {pooled:.3f} >= 0.53, AUC > 0.5 in {wins_auc}/5 (4), top > bottom {wins_top}/5 (4), '
      f'held-out top third {f(top_ps)} > all and > live, blocks low {f(top_lo)} > 0 -> {"PASS" if p1 else "FAIL"}')

if 'no-combos' in opt:
    sys.exit(0)

# ---------------------------------------------------------------------------------------------- PART 2: RULES COMBINED
print('\n== PART 2 - RULES COMBINED (singles, pairs, triples of tertile conditions) ==')
before = (df.day < SPLIT).values
conds, names, fact = [], [], []
for k, c in enumerate(FEATS):
    v = df[c].values; tv = v[before & np.isfinite(v)]
    if len(tv) < 1000:
        continue
    if set(np.unique(tv)) <= {0, 1}:
        cand = [(v == 1, f'{c}=1'), (v == 0, f'{c}=0')]
    else:
        q1, q2 = np.quantile(tv, [1 / 3, 2 / 3])
        cand = [(v <= q1, f'{c}<={q1:.4g}'), (v >= q2, f'{c}>={q2:.4g}')]
    for m, n in cand:
        m = m & np.isfinite(v)
        if m[before].sum() >= MIN_TRADES and not any(np.array_equal(m, x) for x in conds):
            conds.append(m); names.append(n); fact.append(k)
C = np.array(conds); fact = np.array(fact)
print(f'{len(conds)} conditions on {len(set(fact))} facts')

tr = df[before].reset_index(drop=True)
Ct, dk_t, first = C[:, before], tr.dk.values, (tr.day < MID).values
nd = len(days); blk = np.arange(nd) // BLOCK


def score_all(net, combos):
    """Each combination on the trades before the held-out day -> (block low, per session, both halves positive, n, sessions)."""
    out = np.full((len(combos), 4), np.nan)
    for i, cb in enumerate(combos):
        m = Ct[cb[0]].copy()
        for j in cb[1:]:
            m &= Ct[j]
        n = int(m.sum())
        if n < MIN_TRADES:
            continue
        d = dk_t[m]; w = net[m]
        s = np.bincount(d, weights=w, minlength=nd); c = np.bincount(d, minlength=nd)
        has = c > 0
        if has.sum() < MIN_SESSIONS:
            continue
        dm = s[has] / c[has]; pos = np.nonzero(has)[0]
        h1 = pos < first_k
        if not (h1.any() and (~h1).any()) or dm[h1].mean() <= 0 or dm[~h1].mean() <= 0:
            continue
        bs = np.bincount(blk[pos], weights=dm); bc = np.bincount(blk[pos]); bm = bs[bc > 0] / bc[bc > 0]
        out[i] = (bm.mean() - 1.96 * bm.std(ddof=1) / np.sqrt(len(bm)), dm.mean(), n, has.sum())
    return out


first_k = day_pos[next(d for d in days if d >= MID)]
nc = len(conds)
combos = [(a,) for a in range(nc)]
combos += [(a, b) for a in range(nc) for b in range(a + 1, nc) if fact[a] != fact[b]]
combos += [(a, b, c) for a in range(nc) for b in range(a + 1, nc) if fact[a] != fact[b]
           for c in range(b + 1, nc) if fact[c] != fact[a] and fact[c] != fact[b]]
print(f'{len(combos)} combinations searched (>= {MIN_TRADES} trades, >= {MIN_SESSIONS} sessions, positive in both halves)')

real = score_all(tr.net.values, combos)
ok = np.isfinite(real[:, 0])
order = np.argsort(-np.where(ok, real[:, 0], -np.inf))
best = real[order[0], 0]
print(f'{ok.sum()} qualify | best block low {f(best)}')

rng = np.random.default_rng(11)
srt = np.argsort(dk_t, kind='stable')
luck = []
for k in range(SHUFFLES):
    perm = srt[np.lexsort((rng.random(len(tr)), dk_t[srt]))]
    net_s = np.empty(len(tr)); net_s[srt] = tr.net.values[perm]
    sc = score_all(net_s, combos)
    luck.append(np.nanmax(sc[:, 0]) if np.isfinite(sc[:, 0]).any() else -np.inf)
    print(f'  shuffle {k + 1:>2}/{SHUFFLES}: best block low {f(luck[-1])}', flush=True)
p95 = float(np.quantile(luck, 0.95))
print(f'luck check: real best {f(best)} vs the shuffles\' 95th percentile {f(p95)} -> {"clears" if best > p95 else "does NOT clear"}')

te = df[~before]
live_te = te[te.live == 1]
live_ps = per_session(live_te.net.values, live_te.dk.values)
print(f'\nTOP 10, chosen before {SPLIT}, then the held-out year:')
print(line('held out: every run-up trade', te)); print(line('held out: live rule', live_te))
tr_live = tr[tr.live == 1]
print(line('before: live rule', tr_live))
Ce = C[:, ~before]
first_held = None
for rank, i in enumerate(order[:10], 1):
    cb = combos[i]
    m = Ce[cb[0]].copy()
    for j in cb[1:]:
        m &= Ce[j]
    sub = te[m]
    lo_, hi_, _ = block_range(sub.net.values, sub.dk.values)
    ps = per_session(sub.net.values, sub.dk.values)
    if rank == 1:
        first_held = (ps, lo_)
    print(f' #{rank:<2} {" & ".join(names[j] for j in cb)}')
    print(f'     before: {int(real[i, 2])} trades, per session {f(real[i, 1])}, block low {f(real[i, 0])} | held out: {len(sub)} trades, '
          f'per session {f(ps)}, blocks {f(lo_)} .. {f(hi_)}')
p2 = best > p95 and first_held[0] > 0 and first_held[0] > live_ps and first_held[1] > 0
print(f'\nDECLARED (combinations): luck check {"clears" if best > p95 else "fails"}; #1 held out {f(first_held[0])} > 0 and > live '
      f'{f(live_ps)}, blocks low {f(first_held[1])} > 0 -> {"PASS" if p2 else "FAIL"}')
