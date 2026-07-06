#!/usr/bin/env python3
"""Generate src/data.js from verified research (ground.json + profiles.json [+ profiles_b.json]).
All verifier 'fix' findings are applied here via OVERRIDES/REPLACEMENTS."""
import json, os, re, unicodedata

BASE = os.path.dirname(os.path.abspath(__file__))
TASKS = os.path.join(BASE, 'research') if os.path.exists(os.path.join(BASE, 'research')) else os.path.join(BASE, '..', '..', 'tasks')
ground = json.load(open(f'{TASKS}/ground.json'))
profiles = json.load(open(f'{TASKS}/profiles.json'))
profiles_b = json.load(open(f'{TASKS}/profiles_b.json')) if os.path.exists(f'{TASKS}/profiles_b.json') else []
if os.path.exists(f'{TASKS}/profiles_diop.json'):
    profiles_b = list(profiles_b) + json.load(open(f'{TASKS}/profiles_diop.json'))

# ---------------- teams ----------------
# [id, name, flag, group(None if unestablished), status, eliminatedBy, accent]
T = [
 # alive (13)
 ('FRA','France','🇫🇷','I','alive',None,'#5B8DEF'),
 ('ARG','Argentina','🇦🇷','J','alive',None,'#6FC1E8'),
 ('ESP','Spain','🇪🇸','H','alive',None,'#E8402F'),
 ('ENG','England','🏴󠁧󠁢󠁥󠁮󠁧󠁿','L','alive',None,'#E4E9F0'),
 ('POR','Portugal','🇵🇹','K','alive',None,'#93374A'),
 ('NOR','Norway','🇳🇴','I','alive',None,'#EF4B54'),
 ('COL','Colombia','🇨🇴','K','alive',None,'#F5D14B'),
 ('MEX','Mexico','🇲🇽','A','alive',None,'#3EA265'),
 ('MAR','Morocco','🇲🇦','C','alive',None,'#B31E2E'),
 ('USA','United States','🇺🇸','D','alive',None,'#7BA7E0'),
 ('BEL','Belgium','🇧🇪','G','alive',None,'#EFC94C'),
 ('SUI','Switzerland','🇨🇭','B','alive',None,'#FF6B61'),
 ('EGY','Egypt','🇪🇬','G','alive',None,'#CE4A42'),
 # R16 losers
 ('CAN','Canada','🇨🇦','B','eliminated','Morocco','#E0524D'),
 ('PAR','Paraguay','🇵🇾','D','eliminated','France','#D0455C'),
 ('BRA','Brazil','🇧🇷','C','eliminated','Norway','#F2D34C'),
 # R32 losers
 ('RSA','South Africa','🇿🇦','A','eliminated','Canada','#58A868'),
 ('JPN','Japan','🇯🇵',None,'eliminated','Brazil','#6C7BD8'),
 ('GER','Germany','🇩🇪','E','eliminated','Paraguay','#DADADA'),
 ('NED','Netherlands','🇳🇱',None,'eliminated','Morocco','#EF8A3C'),
 ('SWE','Sweden','🇸🇪',None,'eliminated','France','#F0CB4C'),
 ('CIV','Ivory Coast','🇨🇮','E','eliminated','Norway','#EF9440'),
 ('ECU','Ecuador','🇪🇨','E','eliminated','Mexico','#F2D34C'),
 ('BIH','Bosnia and Herzegovina','🇧🇦','B','eliminated','United States','#6C86D8'),
 ('SEN','Senegal','🇸🇳','I','eliminated','Belgium','#56B56B'),
 ('COD','DR Congo','🇨🇩','K','eliminated','England','#5B9BD8'),
 ('CRO','Croatia','🇭🇷','L','eliminated','Portugal','#E05B6B'),
 ('AUT','Austria','🇦🇹','J','eliminated','Spain','#D95252'),
 ('ALG','Algeria','🇩🇿','J','eliminated','Switzerland','#4FA36B'),
 ('CPV','Cabo Verde','🇨🇻','H','eliminated','Argentina','#4F86C9'),
 ('AUS','Australia','🇦🇺','D','eliminated','Egypt','#EFC94C'),
 ('GHA','Ghana','🇬🇭','L','eliminated','Colombia','#E8C74E'),
 # group-stage exits referenced by players / fallen stars
 ('CUW','Curaçao','🇨🇼','E','eliminated',None,'#5BA8D8'),
 ('KSA','Saudi Arabia','🇸🇦','H','eliminated',None,'#4FA36B'),
 ('IRN','Iran','🇮🇷','G','eliminated',None,'#56B56B'),
 ('KOR','South Korea','🇰🇷','A','eliminated',None,'#E05B6B'),
 ('URU','Uruguay','🇺🇾','H','eliminated',None,'#6FB6E0'),
]
NAME2ID = {name: tid for tid, name, *_ in T}
NAME2ID.update({'Cape Verde':'CPV', 'Curacao':'CUW', 'USA':'USA', 'Türkiye':None})

# odds (FanDuel via FOX, July 5 ~7:15pm ET) -> normalized to 100 across alive teams
IMPLIED = {'FRA':38.46,'ARG':18.52,'ESP':15.38,'ENG':9.52,'POR':6.67,'NOR':6.67,
           'COL':4.35,'MEX':4.35,'MAR':3.23,'USA':3.23,'BEL':1.96,'SUI':1.64,'EGY':0.33}
tot = sum(IMPLIED.values())
PROB = {k: round(v / tot * 100, 1) for k, v in IMPLIED.items()}

teams = []
for tid, name, flag, grp, status, elimBy, accent in T:
    teams.append({
        'id': tid, 'name': name, 'flagEmoji': flag, 'group': grp,
        'status': status, 'eliminatedBy': elimBy,
        'titleProbability': PROB.get(tid) if status == 'alive' else None,
        'strength': 0,  # derived at runtime from titleProbability (see app SIM comment)
        'accentColor': accent,
    })

# ---------------- bracket (binary tree order: match i of round r+1 <- matches 2i, 2i+1) ----------------
def M(mid, a, b, sa, sb, pens, win, date, played, venue=None):
    return {'id': mid, 'teamA': a, 'teamB': b, 'scoreA': sa, 'scoreB': sb,
            'penalties': pens, 'winner': win, 'date': date, 'played': played}

R32 = [
 M('R32-1','GER','PAR',1,1,'4-3','PAR','Jun 29',True),
 M('R32-2','FRA','SWE',3,0,None,'FRA','Jun 30',True),
 M('R32-3','RSA','CAN',0,1,None,'CAN','Jun 28',True),
 M('R32-4','NED','MAR',1,1,'3-2','MAR','Jun 29',True),
 M('R32-5','POR','CRO',2,1,None,'POR','Jul 2',True),
 M('R32-6','ESP','AUT',3,0,None,'ESP','Jul 2',True),
 M('R32-7','USA','BIH',2,0,None,'USA','Jul 1',True),
 M('R32-8','BEL','SEN',3,2,None,'BEL','Jul 1',True),
 M('R32-9','BRA','JPN',2,1,None,'BRA','Jun 29',True),
 M('R32-10','CIV','NOR',1,2,None,'NOR','Jun 30',True),
 M('R32-11','MEX','ECU',2,0,None,'MEX','Jun 30',True),
 M('R32-12','ENG','COD',2,1,None,'ENG','Jul 1',True),
 M('R32-13','ARG','CPV',3,2,None,'ARG','Jul 3',True),
 M('R32-14','AUS','EGY',1,1,'4-2','EGY','Jul 3',True),
 M('R32-15','SUI','ALG',2,0,None,'SUI','Jul 2',True),
 M('R32-16','COL','GHA',1,0,None,'COL','Jul 3',True),
]
# NOTE: pens strings are winner-perspective in source; normalize display in app via winner name.
R16 = [
 M('R16-1','PAR','FRA',0,1,None,'FRA','Jul 4',True),
 M('R16-2','CAN','MAR',0,3,None,'MAR','Jul 4',True),
 M('R16-3','POR','ESP',None,None,None,None,'Jul 6',False),
 M('R16-4','USA','BEL',None,None,None,None,'Jul 6',False),
 M('R16-5','BRA','NOR',1,2,None,'NOR','Jul 5',True),
 M('R16-6','MEX','ENG',None,None,None,None,'Jul 5 · delayed',False),
 M('R16-7','ARG','EGY',None,None,None,None,'Jul 7',False),
 M('R16-8','SUI','COL',None,None,None,None,'Jul 7',False),
]
QF = [
 M('QF-1','FRA','MAR',None,None,None,None,'Jul 9',False),
 M('QF-2',None,None,None,None,None,None,'Jul 10',False),
 M('QF-3','NOR',None,None,None,None,None,'Jul 11',False),
 M('QF-4',None,None,None,None,None,None,'Jul 11',False),
]
SF = [
 M('SF-1',None,None,None,None,None,None,'Jul 14',False),
 M('SF-2',None,None,None,None,None,None,'Jul 15',False),
]
FIN = [M('F-1',None,None,None,None,None,None,'Jul 19 · MetLife',False)]

# fix pens strings to A-B orientation of the row display (app prints "<winner> win <pens> on penalties") -> keep as given
bracket = {'rounds': [
    {'name': 'Round of 32', 'matches': R32},
    {'name': 'Round of 16', 'matches': R16},
    {'name': 'Quarterfinals', 'matches': QF},
    {'name': 'Semifinals', 'matches': SF},
    {'name': 'Final', 'matches': FIN},
]}

# sanity: winners of played matches feed the right slot
rounds = bracket['rounds']
for ri in range(1, len(rounds)):
    for mi, m in enumerate(rounds[ri]['matches']):
        fA = rounds[ri-1]['matches'][mi*2]; fB = rounds[ri-1]['matches'][mi*2+1]
        if fA['played'] and m['teamA'] and m['teamA'] != fA['winner']:
            raise SystemExit(f"tree mismatch {m['id']} A: {m['teamA']} vs feeder {fA['id']} winner {fA['winner']}")
        if fB['played'] and m['teamB'] and m['teamB'] != fB['winner']:
            raise SystemExit(f"tree mismatch {m['id']} B: {m['teamB']} vs feeder {fB['id']} winner {fB['winner']}")

# ---------------- tier 1 players from profiles ----------------
def slug(name):
    s = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')

# Verifier 'fix' findings -> applied as overrides / exact string replacements
OVERRIDES = {
 'Michael Olise':   {'stats.matchesPlayed': 5},
 'Erling Haaland':  {'stats.matchesPlayed': 4},
 'Ismael Saibari':  {'club': 'Bayern Munich', 'league': 'Bundesliga', 'clubCity': 'Munich',
                     'clubCountry': 'Germany', 'clubLatLng': [48.14, 11.58]},
}
REPLACEMENTS = {  # exact substring -> replacement, applied across all text fields of that player
 'Kylian Mbappé': [
   ('score 2 or more goals in six different World Cup matches',
    'score 2 or more goals in seven different World Cup matches'),
 ],
 'Michael Olise': [
   ('Five assists in four games', 'Five assists in five games'),
 ],
 'Harry Kane': [
   ('61 goals in 51 games for Bayern', '58 goals in all competitions for Bayern'),
 ],
 'Lionel Messi': [
   ('He is locked in a Golden Boot duel with Kylian Mbappe, both on 7 goals with Mbappe ahead on the assists tiebreaker',
    'He is locked in a three-way Golden Boot tie with Mbappe and Haaland, all on 7 goals with Mbappe ahead on the assists tiebreaker'),
 ],
 'Julio Enciso': [
   ('A month before the tournament he was stretchered off in tears against Nicaragua',
    'A week before Paraguay\N{RIGHT SINGLE QUOTATION MARK}s opener he was stretchered off in tears against Nicaragua'),
 ],
 'Ismael Saibari': [
   ('his Scotland strike was the fastest goal of the tournament and made him Morocco\N{RIGHT SINGLE QUOTATION MARK}s joint-record World Cup scorer alongside En-Nesyri',
    'his Scotland strike (71 seconds) was the fastest goal of the tournament until it was beaten later that same day, and his third, against Haiti, made him Morocco\N{RIGHT SINGLE QUOTATION MARK}s joint-record World Cup scorer alongside Youssef En-Nesyri'),
   ("his Scotland strike was the fastest goal of the tournament and made him Morocco's joint-record World Cup scorer alongside En-Nesyri",
    "his Scotland strike (71 seconds) was the fastest goal of the tournament until it was beaten later that same day, and his third, against Haiti, made him Morocco's joint-record World Cup scorer alongside Youssef En-Nesyri"),
 ],
 'Cristiano Ronaldo': [
   ('win over Croatia on July 3', 'win over Croatia on July 2'),
   ('41 years and 146 days', '41 years and 147 days'),
 ],
 'Jude Bellingham': [
   ('started with shoulder surgery and a September return', 'started with shoulder surgery and a delayed return'),
 ],
 'Vozinha': [
   ('Ely Room', 'Eloy Room'),
   ('he gained roughly 17 million Instagram followers within days of the Spain match and has now passed Iker Casillas as the most-followed goalkeeper on social media',
    'his Instagram went from about 56,000 followers to more than 14 million in three weeks'),
 ],
 'Issa Diop': [
   ('four months after switching to Morocco', 'three and a half months after switching to Morocco'),
   ('Morocco legend Mustapha Hadji flew to London and asked him about his Moroccan mother to win him over. FIFA approved his switch from France on March 26, 2026,',
    'Morocco legend Mustapha Hadji had courted him for years, meeting him in London back in his West Ham days to ask about his Moroccan mother. FIFA approved the switch from France on March 26, 2026,'),
 ],
 'Eloy Room': [
   ('the Ecuador heroics five days later', 'the Ecuador heroics six days later'),
 ],
 'Orlando Gill': [
   ('in September 2025 in a friendly against Peru', 'in September 2025 in a World Cup qualifier against Peru'),
 ],
 'Achraf Hakimi': [
   ("Ligue 1 and a third Champions League with PSG (won on penalties over Arsenal)",
    "Ligue 1 and his third Champions League overall, PSG's second in a row, won on penalties over Arsenal"),
 ],
 'Johan Manzambi': [
   ('named Europa League Young Player of the Season', 'named the Europa League\N{RIGHT SINGLE QUOTATION MARK}s Revelation of the Season'),
   ("named Europa League Young Player of the Season", "named the Europa League's Revelation of the Season"),
 ],
}

def apply_fixes(p):
    name = p['name']
    for path, val in OVERRIDES.get(name, {}).items():
        parts = path.split('.')
        tgt = p
        for k in parts[:-1]: tgt = tgt[k]
        tgt[parts[-1]] = val
    reps = REPLACEMENTS.get(name, [])
    def fix(s):
        if not isinstance(s, str): return s
        for a, b in reps: s = s.replace(a, b)
        return s
    p['knownFor'] = fix(p['knownFor']); p['watchBecause'] = fix(p['watchBecause'])
    p['storylines'] = [fix(s) for s in p['storylines']]
    return p

players = []
seen = set()
for batch in list(profiles) + list(profiles_b):
    for p in batch['data']['players']:
        p = apply_fixes(dict(p))
        tid = NAME2ID.get(p['nationalTeam'])
        if not tid: raise SystemExit('unknown team ' + p['nationalTeam'])
        pid = slug(p['name'])
        if pid in seen: continue
        seen.add(pid)
        st = p['stats'] or {}
        stats = {k: st.get(k) for k in
                 (('saves','cleanSheets','goalsConceded','matchesPlayed') if p['position']=='GK'
                  else ('matchesPlayed','goals','assists','cleanSheets') if p['position']=='DEF'
                  else ('goals','assists','shots','matchesPlayed'))}
        players.append({
            'id': pid, 'name': p['name'], 'teamId': tid, 'tier': 1,
            'position': p['position'], 'age': p.get('age'),
            'club': p.get('club'), 'league': p.get('league'),
            'clubCity': p.get('clubCity'), 'clubCountry': p.get('clubCountry'),
            'clubLatLng': p.get('clubLatLng'),
            'birthplace': ({'city': p['birthCity'], 'country': p['birthCountry'], 'latLng': p['birthLatLng']}
                           if p.get('birthCity') and p.get('birthLatLng') else None),
            'knownFor': p['knownFor'], 'watchBecause': p['watchBecause'],
            'storylines': p['storylines'], 'stats': stats,
            'statusNote': p.get('squadStatus'),
        })

# ---------------- tier 2 (light cards; stats only where verified by leaders/GK research; unknown club -> None) ----------------
def t2(name, tid, pos, age, club, city, country, latlng, known, **st):
    stats = {'goals': st.get('g'), 'assists': st.get('a'), 'shots': None, 'matchesPlayed': st.get('mp')}
    if pos == 'GK':
        stats = {'saves': st.get('sv'), 'cleanSheets': st.get('cs'), 'goalsConceded': st.get('gc'), 'matchesPlayed': st.get('mp')}
    if pos == 'DEF':
        stats = {'matchesPlayed': st.get('mp'), 'goals': st.get('g'), 'assists': st.get('a'), 'cleanSheets': st.get('cs')}
    return {'id': slug(name), 'name': name, 'teamId': tid, 'tier': 2, 'position': pos, 'age': age,
            'club': club, 'league': None, 'clubCity': city, 'clubCountry': country,
            'clubLatLng': latlng, 'birthplace': None,
            'knownFor': known, 'watchBecause': '', 'storylines': [], 'stats': stats, 'statusNote': None}

TIER2 = [
 t2('Ousmane Dembélé','FRA','FWD',29,'Paris Saint-Germain','Paris','France',[48.86,2.35],
    'The reigning Ballon d\N{RIGHT SINGLE QUOTATION MARK}Or winner, two-footed chaos on either wing.', g=4),
 t2('Mikel Oyarzabal','ESP','FWD',29,'Real Sociedad','San Sebastián','Spain',[43.32,-1.98],
    'Spain\N{RIGHT SINGLE QUOTATION MARK}s captain-in-spirit and Euro 2024 final scorer, quietly on 4 goals here.', g=4, a=1),
 t2('Unai Simón','ESP','GK',29,'Athletic Club','Bilbao','Spain',[43.26,-2.93],
    'Broke a 36-year-old record with 517+ shutout minutes behind Spain\N{RIGHT SINGLE QUOTATION MARK}s unbreached defense.', cs=4, gc=0, mp=4),
 t2('Ismaïla Sarr','SEN','FWD',28,'Crystal Palace','London','England',[51.51,-0.12],
    'Senegal\N{RIGHT SINGLE QUOTATION MARK}s spearhead: 4 goals before Belgium ended the run 3-2.', g=4, a=1),
 t2('Julián Quiñones','MEX','FWD',29,None,None,None,None,
    'Naturalized striker with 3 goals in Mexico\N{RIGHT SINGLE QUOTATION MARK}s shutout machine.', g=3, a=1),
 t2('Roberto Alvarado','MEX','MID',27,'Guadalajara','Guadalajara','Mexico',[20.67,-103.35],
    'El Piojo: 3 assists in a Mexico side that has not conceded at home.', a=3),
 t2('Bruno Guimarães','BRA','MID',28,'Newcastle United','Newcastle','England',[54.98,-1.61],
    'Brazil\N{RIGHT SINGLE QUOTATION MARK}s midfield heartbeat: 4 assists, then a saved penalty in the Norway exit.', a=4),
 t2('Brahim Díaz','MAR','MID',26,'Real Madrid','Madrid','Spain',[40.42,-3.70],
    'Madrid\N{RIGHT SINGLE QUOTATION MARK}s silky playmaker, 4 assists for the Atlas Lions.', a=4),
 t2('Alexander Isak','SWE','FWD',26,'Liverpool','Liverpool','England',[53.41,-2.98],
    'Sweden\N{RIGHT SINGLE QUOTATION MARK}s elegant No. 9: 3 assists before France closed the door.', a=3),
 t2('Martin Ødegaard','NOR','MID',27,'Arsenal','London','England',[51.51,-0.12],
    'Norway\N{RIGHT SINGLE QUOTATION MARK}s captain and Haaland\N{RIGHT SINGLE QUOTATION MARK}s supply line, 3 assists and counting.', a=3),
 t2('Florian Wirtz','GER','MID',23,'Liverpool','Liverpool','England',[53.41,-2.98],
    'Germany\N{RIGHT SINGLE QUOTATION MARK}s brightest creator, 3 assists in a tournament that ended too soon.', a=3),
 t2('Andreas Schjelderup','NOR','FWD',22,'Benfica','Lisbon','Portugal',[38.72,-9.14],
    'The other Norwegian the scouts rave about: 3 assists on Haaland\N{RIGHT SINGLE QUOTATION MARK}s wing.', a=3),
 t2('Mohammed Al-Owais','KSA','GK',34,'Al-Hilal','Riyadh','Saudi Arabia',[24.71,46.68],
    'Made 9 saves in one game against Uruguay, the most in a single World Cup match this century.', sv=16, mp=3),
 t2('Bart Verbruggen','NED','GK',23,'Brighton & Hove Albion','Brighton','England',[50.82,-0.14],
    'The busiest contender keeper: 16 saves, no clean sheet, a shootout exit.', sv=16, cs=0, gc=5, mp=4),
 t2('Alireza Beiranvand','IRN','GK',33,'Persepolis','Tehran','Iran',[35.69,51.39],
    'Stonewalled Belgium with 7 saves; Iran drew all three games and still went home.', sv=15, cs=1, mp=3),
 t2('Lionel Mpasi','COD','GK',32,None,None,None,None,
    'Breakout keeper of DR Congo\N{RIGHT SINGLE QUOTATION MARK}s first-ever knockout run; clawed two Bellingham headers away.', sv=14, cs=0, gc=5, mp=4),
 t2('Patrick Beach','AUS','GK',22,None,None,None,None,
    'A 22-year-old former softball player picked over Mat Ryan, and it worked: 2 clean sheets.', sv=14, cs=2, gc=3, mp=4),
 t2('Zion Suzuki','JPN','GK',23,'Parma','Parma','Italy',[44.80,10.33],
    'Japan\N{RIGHT SINGLE QUOTATION MARK}s young wall until Brazil edged them 2-1 in the round of 32.', sv=14, cs=1, gc=5, mp=4),
 t2('Nestory Irankunda','AUS','FWD',20,None,None,None,None,
    'Became the youngest Australian to score at a World Cup and a national hero overnight.'),
 t2('Folarin Balogun','USA','FWD',25,'AS Monaco','Monaco','Monaco',[43.73,7.42],
    'The most argued-about man in the sport: a VAR red card, a Trump phone call, a FIFA reprieve.'),
 t2('Christian Pulisic','USA','FWD',27,'AC Milan','Milan','Italy',[45.46,9.19],
    'Captain America, leading the USMNT\N{RIGHT SINGLE QUOTATION MARK}s chase of a first quarterfinal since 2002.'),
 t2('Kevin De Bruyne','BEL','MID',35,'Napoli','Naples','Italy',[40.85,14.27],
    'Belgium\N{RIGHT SINGLE QUOTATION MARK}s last golden-generation conductor, one more shot at a World Cup run.'),
 t2('Azzedine Ounahi','MAR','MID',26,None,None,None,None,
    'The 2022 revelation doing it again: a double that sent co-host Canada home.', g=2),
 t2('Issa Diop','MAR','DEF',29,'Fulham','London','England',[51.51,-0.12],
    'His 91st-minute equalizer against the Netherlands saved Morocco before the shootout did the rest.', g=1),
 t2('Yassine Bounou','MAR','GK',35,'Al-Hilal','Riyadh','Saudi Arabia',[24.71,46.68],
    'Bono: the 2022 shootout legend did it to the Netherlands again in 2026.'),
 t2('Gonçalo Ramos','POR','FWD',25,'Paris Saint-Germain','Paris','France',[48.86,2.35],
    'Scored the 94th-minute winner against Croatia; pundits ask if he should start over Ronaldo.', g=1),
 t2('Cody Gakpo','NED','FWD',27,'Liverpool','Liverpool','England',[53.41,-2.98],
    'Scored the opener against Morocco, then watched a third straight Dutch shootout defeat.', g=1),
 t2('Jonathan Tah','GER','DEF',30,'Bayern Munich','Munich','Germany',[48.14,11.58],
    'Scored the extra-time goal VAR erased against Paraguay, then missed in the shootout.'),
 t2('Alphonso Davies','CAN','DEF',25,'Bayern Munich','Munich','Germany',[48.14,11.58],
    'Canada\N{RIGHT SINGLE QUOTATION MARK}s superstar watched the Morocco defeat from the bench, hamstring untrusted.'),
 t2('Ørjan Nyland','NOR','GK',35,'Sevilla','Seville','Spain',[37.39,-5.99],
    'Norway\N{RIGHT SINGLE QUOTATION MARK}s oldest player saved a Bruno Guimarães penalty and stonewalled Brazil.'),
 t2('Amad Diallo','CIV','FWD',24,'Manchester United','Manchester','England',[53.48,-2.24],
    'His 74th-minute equalizer against Norway had Ivory Coast dreaming for twelve minutes.', g=1),
]

TIER2 = [t for t in TIER2 if t['id'] not in seen]  # a tier-1 deep profile supersedes the light card
players += TIER2

# ---------------- leaders (verifier fixes applied: Schjelderup in, Mbappé out of top-8 assists; Dembélé assists unconfirmed) ----------------
leaders = {
 'topScorers': [
   {'name':'Kylian Mbappé','team':'France','goals':7,'assists':2},
   {'name':'Lionel Messi','team':'Argentina','goals':7,'assists':1},
   {'name':'Erling Haaland','team':'Norway','goals':7,'assists':0},
   {'name':'Harry Kane','team':'England','goals':5,'assists':None},
   {'name':'Ousmane Dembélé','team':'France','goals':4,'assists':None},
   {'name':'Mikel Oyarzabal','team':'Spain','goals':4,'assists':1},
   {'name':'Vinícius Júnior','team':'Brazil','goals':4,'assists':1},
   {'name':'Ismaïla Sarr','team':'Senegal','goals':4,'assists':1},
   {'name':'Johan Manzambi','team':'Switzerland','goals':3,'assists':2},
   {'name':'Julián Quiñones','team':'Mexico','goals':3,'assists':1},
 ],
 'topAssists': [
   {'name':'Michael Olise','team':'France','assists':5,'goals':0},
   {'name':'Bruno Guimarães','team':'Brazil','assists':4,'goals':None},
   {'name':'Brahim Díaz','team':'Morocco','assists':4,'goals':None},
   {'name':'Roberto Alvarado','team':'Mexico','assists':3,'goals':None},
   {'name':'Alexander Isak','team':'Sweden','assists':3,'goals':None},
   {'name':'Martin Ødegaard','team':'Norway','assists':3,'goals':None},
   {'name':'Florian Wirtz','team':'Germany','assists':3,'goals':None},
   {'name':'Andreas Schjelderup','team':'Norway','assists':3,'goals':None},
 ],
 'gkLeaders': [
   {'name':'Eloy Room','team':'Curaçao','saves':20,'cleanSheets':1,'goalsConceded':9},
   {'name':'Orlando Gill','team':'Paraguay','saves':19,'cleanSheets':None,'goalsConceded':None},
   {'name':'Vozinha','team':'Cabo Verde','saves':18,'cleanSheets':2,'goalsConceded':5},
   {'name':'Mohammed Al-Owais','team':'Saudi Arabia','saves':16,'cleanSheets':None,'goalsConceded':None},
   {'name':'Bart Verbruggen','team':'Netherlands','saves':16,'cleanSheets':0,'goalsConceded':5},
   {'name':'Alireza Beiranvand','team':'Iran','saves':15,'cleanSheets':1,'goalsConceded':None},
   {'name':'Lionel Mpasi','team':'DR Congo','saves':14,'cleanSheets':0,'goalsConceded':5},
   {'name':'Patrick Beach','team':'Australia','saves':14,'cleanSheets':2,'goalsConceded':3},
   {'name':'Diogo Costa','team':'Portugal','saves':14,'cleanSheets':2,'goalsConceded':2},
   {'name':'Zion Suzuki','team':'Japan','saves':14,'cleanSheets':1,'goalsConceded':5},
 ],
}

# ---------------- stories (fixes: Kane passed Pelé's 12; France 3-0 Sweden) ----------------
raw_stories = ground['stories']['data']['tournamentStorylines']
order = [0, 1, 5, 4, 9, 8, 7, 3, 2, 6]
stories = []
for i in order:
    s = dict(raw_stories[i])
    s['detail'] = s['detail'].replace("passed Pele's 13-goal career mark", "passed Pele's 12-goal career mark")
    s['detail'] = s['detail'].replace('ground past Sweden 2-0 and Paraguay 1-0', 'cruised past Sweden 3-0 and ground out a 1-0 over Paraguay')
    stories.append({'headline': s['headline'], 'detail': s['detail']})

fallen = ground['stories']['data']['fallenStars']

meta = {
 'rev': 2,  # bump on every data regeneration; boot() compares it against the stored blob
 'asOf': 'July 5, 2026, ~8:00 PM ET',
 'stage': 'Round of 16',
 'stageNote': 'France, Morocco and Norway are through to the quarterfinals. Mexico vs England kicks off tonight at a storm-soaked Azteca; four more last-16 ties follow July 6 and 7.',
 'oddsSource': 'FanDuel, Jul 5',
 'nextMatches': [
   {'teams':'Mexico vs England','date':'Jul 5','round':'Round of 16 · storm-delayed'},
   {'teams':'Portugal vs Spain','date':'Jul 6','round':'Round of 16'},
   {'teams':'United States vs Belgium','date':'Jul 6','round':'Round of 16'},
   {'teams':'Argentina vs Egypt','date':'Jul 7','round':'Round of 16'},
   {'teams':'Switzerland vs Colombia','date':'Jul 7','round':'Round of 16'},
   {'teams':'France vs Morocco','date':'Jul 9','round':'Quarterfinal'},
 ],
}

# ---------------- photos (Wikipedia CC thumbnails, baked as data URIs) + squad numbers ----------------
photos = json.load(open(f'{BASE}/photos.json')) if os.path.exists(f'{BASE}/photos.json') else {}
numbers = {}
if os.path.exists(f'{BASE}/numbers.json'):
    for n in json.load(open(f'{BASE}/numbers.json')):
        numbers[slug(n['player'].split(' (')[0])] = n['number']
for p in players:
    p['photo'] = photos.get(p['id'])
    p['number'] = numbers.get(p['id'])
missing_nums = [p['name'] for p in players if p['number'] is None]
print(f'photos on {sum(1 for p in players if p["photo"])} players, numbers on {sum(1 for p in players if p["number"] is not None)}; no number: {missing_nums or "none"}')

DATA = {'meta': meta, 'teams': teams, 'players': players, 'bracket': bracket,
        'leaders': leaders, 'fallenStars': fallen, 'stories': stories}

# ---- integrity checks ----
ids = {t['id'] for t in teams}
for p in players:
    assert p['teamId'] in ids, p['name']
    if p['clubLatLng']: assert -90 <= p['clubLatLng'][0] <= 90 and -180 <= p['clubLatLng'][1] <= 180, p['name']
    if p['birthplace']: assert -90 <= p['birthplace']['latLng'][0] <= 90, p['name']
pids = [p['id'] for p in players]
assert len(pids) == len(set(pids)), 'dup player ids'
t1 = [p for p in players if p['tier'] == 1]
gk1 = [p for p in t1 if p['position'] == 'GK']; d1 = [p for p in t1 if p['position'] == 'DEF']
nteams = {p['teamId'] for p in t1}
print(f'tier1={len(t1)} (GK={len(gk1)}, DEF={len(d1)}, teams={len(nteams)}), tier2={len(TIER2)}, teams={len(teams)}')
print(f'alive prob sum={sum(PROB.values()):.1f}')
if len(gk1) < 3: print('WARN: <3 tier1 GKs (profiles_b pending?)')
if len(d1) < 3: print('WARN: <3 tier1 DEFs (profiles_b pending?)')

out = 'const LAND = "__LANDPATH__";\nconst DATA = ' + json.dumps(DATA, ensure_ascii=False, indent=1) + ';\n'
open(f'{BASE}/src/data.js', 'w').write(out)
print('wrote src/data.js:', len(out)//1024, 'KB')
