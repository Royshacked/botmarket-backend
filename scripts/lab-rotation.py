# WHICH RULE, WHEN -- test L (screener-lab.md section 29, declared before the run). Reads the books scripts/lab-rotation.mjs
# writes: each library rule's daily excess over SPY. Step 2 MOMENTUM (the rules that did best lately), step 3 THE MARKET
# STATE (the rules that did best in this kind of market), against ALL rules held equally and RANDOM picks.
#
#   python scripts/lab-rotation.py
import numpy as np
import pandas as pd

BEFORE, HELD, END = ('2019-07', '2023-12'), ('2024-01', '2026-09'), '2026-09'
L0, K0, DRAWS, MIN_STATE = 6, 3, 2000, 6
rng = np.random.default_rng(5)

d = pd.read_csv('data/lab/rotation-daily.csv')
d['month'] = d.day.str[:7]
M = d.groupby(['month', 'rule']).ret.sum().unstack()
M = M[(M.index >= '2019-01') & (M.index <= END)]
rules = list(M.columns)
reg = pd.read_csv('data/lab/rotation-regimes.csv').fillna('')
last_of = reg.assign(month=reg.day.str[:7]).groupby('month').regime.last()
# The state the evening before a month's first session: the previous month's last evening.
state = pd.Series({m: last_of.get((pd.Period(m) - 1).strftime('%Y-%m'), '') for m in M.index})
months = list(M.index)
R = M.values


def f(x):
    return f'{x:+.2f}%'.rjust(7)


def tstat(x):
    x = np.asarray(x, float)
    return x.mean() / (x.std(ddof=1) / np.sqrt(len(x))) if len(x) > 2 else np.nan


def span(a, b):
    return [k for k, m in enumerate(months) if a <= m <= b]


print('== each rule, net vs SPY a month (mean), by year')
yr = M.groupby(M.index.str[:4]).mean()
print('  ' + 'rule'.ljust(20) + ''.join(y.rjust(8) for y in yr.index) + '   whole')
for r in rules:
    print('  ' + r.ljust(20) + ''.join(f(v).rjust(8) for v in yr[r]) + '  ' + f(M[r].mean()))
ew = R.mean(axis=1)
print('  ' + 'ALL 14 equally'.ljust(20) + ''.join(f(v).rjust(8) for v in pd.Series(ew, index=months).groupby(np.array(months).astype(str).astype('U4')).mean()) + '  ' + f(ew.mean()))
best = M.groupby(M.index.str[:4]).mean().idxmax(axis=1)
print('  the best rule each year: ' + ', '.join(f'{y} {r}' for y, r in best.items()))


def momentum(L, K):
    out = np.full(len(months), np.nan)
    for k in range(L, len(months)):
        score = R[k - L:k].sum(axis=0)
        out[k] = R[k, np.argsort(-score, kind='stable')[:K]].mean()
    return out


def random_p95(idx, K):
    sims = np.array([R[idx][np.arange(len(idx))[:, None], np.argsort(rng.random((len(idx), len(rules))), axis=1)[:, :K]].mean() for _ in range(DRAWS)])
    return np.quantile(sims, 0.95), sims.mean()


def report(name, sw, idx, K):
    x, e = sw[idx], ew[idx]
    p95, rmean = random_p95(idx, K)
    print(f'  {name:<26} {len(idx):>3} months  switcher {f(x.mean())}  ALL {f(e.mean())}  diff t {tstat(x - e):+.2f}  '
          f'random mean {f(rmean)} p95 {f(p95)}')
    return x.mean() > e.mean(), x.mean() > p95


print(f'\n== STEP 2 - MOMENTUM (primary L={L0} months, top K={K0})')
b, h = span(*BEFORE), span(*HELD)
sw = momentum(L0, K0)
b1, b2 = report('before 2019-07 -> 2023-12', sw, b, K0)
h1, h2 = report('HELD OUT 2024-01 -> 2026-09', sw, h, K0)
w1, w2 = report('whole', sw, b + h, K0)
print(f'DECLARED (momentum): above ALL before {b1} and held out {h1}; above random p95 before {b2} and held out {h2} '
      f'-> {"PASS" if b1 and h1 and b2 and h2 else "FAIL"}')
print('\n  sensitivity (not the bar) - mean month, switcher less ALL, before | held out:')
for L in (1, 3, 6, 12):
    cells = []
    for K in (1, 3, 5):
        s = momentum(L, K)
        bb, hh = [k for k in b if np.isfinite(s[k])], [k for k in h if np.isfinite(s[k])]
        cells.append(f'K={K} {f(s[bb].mean() - ew[bb].mean())} | {f(s[hh].mean() - ew[hh].mean())}')
    print(f'    L={L:<2} ' + '   '.join(cells))

print(f'\n== STEP 3 - THE MARKET STATE (top K={K0} for the state, learned on 2019-01 -> 2023-12)')
learn = [k for k, m in enumerate(months) if m <= BEFORE[1]]
print('  months per state, learned span: ' + ', '.join(f'{s or "?"} {n}' for s, n in state.iloc[learn].value_counts().items()))
for s in sorted(set(state.iloc[learn]) - {''}):
    ks = [k for k in learn if state.iloc[k] == s]
    means = R[ks].mean(axis=0)
    top = np.argsort(-means)[:K0]
    print(f'  {s:<26} ({len(ks):>2} months) top: ' + ', '.join(f'{rules[j]} {f(means[j])}' for j in top))


def by_state(k, ks):
    ks = [j for j in ks if state.iloc[j] == state.iloc[k]]
    if len(ks) < MIN_STATE:
        return ew[k]
    return R[k, np.argsort(-R[ks].mean(axis=0), kind='stable')[:K0]].mean()


fixed = np.array([by_state(k, learn) if k in h else np.nan for k in range(len(months))])
print('  held-out states: ' + ', '.join(f'{s} {n}' for s, n in state.iloc[h].value_counts().items()))
s1, s2 = report('HELD OUT (fixed map)', fixed, h, K0)
expanding = np.array([by_state(k, list(range(k))) if k >= 12 else np.nan for k in range(len(months))])
report('before (expanding, shown)', expanding, [k for k in b if np.isfinite(expanding[k])], K0)
report('held out (expanding, shown)', expanding, h, K0)
print(f'DECLARED (market state): held out above ALL {s1}, above random p95 {s2} -> {"PASS" if s1 and s2 else "FAIL"}')

# For the eye: does a rule's good stretch carry? Each rule's month against its own last 6 (rank correlation, pooled).
ranks_now, ranks_past = [], []
for k in range(6, len(months)):
    ranks_now.append(pd.Series(R[k]).rank().values); ranks_past.append(pd.Series(R[k - 6:k].sum(axis=0)).rank().values)
rc = [np.corrcoef(a, p)[0, 1] for a, p in zip(ranks_now, ranks_past)]
print(f'\n  rank correlation, a rule\'s last 6 months -> its next: mean {np.mean(rc):+.3f} (t {tstat(rc):+.2f}, {len(rc)} months)')
