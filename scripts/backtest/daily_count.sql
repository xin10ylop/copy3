-- Qualifying launches per UTC day from the indexer database (team buys >= 0.02 ETH from >= 2
-- tax-exempt non-deployer wallets in the launch second, ETH pair). The strategy's income is
-- proportional to this count. Paste into:  hoodctl psql -c "<query>"
select date_trunc('day', l.ts) as day, count(*) as launches,
       count(*) filter (where q.team >= 0.02 and q.wallets >= 2) as qualifying
  from launches l
  left join lateral (
    select coalesce(sum(t.quote), 0) / 1e18 as team, count(distinct t.recipient) as wallets
      from curve_trades t
     where t.token = l.token and t.side = 'buy' and t.exempt and t.recipient <> l.deployer and t.seconds_since_launch = 0
  ) q on true
 where l.ts >= now() - interval '7 days' and l.pair_token = '0x0000000000000000000000000000000000000000'
 group by 1 order by 1;
