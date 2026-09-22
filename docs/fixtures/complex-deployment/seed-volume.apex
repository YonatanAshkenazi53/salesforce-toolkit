// SFTK volume fixture — SOURCE org. Run it several times with different
// __FROM__/__TO__ (the runbook substitutes them): each run stays under the
// 10,000-row DML limit of one anonymous transaction.
//   pass "acc"  : Accounts SFTK VOL 00001..N   (one run per 6,000)
//   pass "con"  : 2 Contacts per Account       (one run per 3,000 accounts)
//   pass "opp"  : 1 Opportunity per Account    (one run per 6,000)
// Everything is prefixed "SFTK VOL"; cleanup-volume.apex removes it.
String pad(Integer i) { String n = String.valueOf(i); while (n.length() < 5) n = '0' + n; return n; }
String pass = '__PASS__';
Integer fromN = __FROM__, toN = __TO__;
Database.DMLOptions dmo = new Database.DMLOptions(); dmo.DuplicateRuleHeader.allowSave = true; dmo.optAllOrNone = true;
String[] industries = new String[]{'Technology','Retail','Energy','Media','Consulting','Manufacturing','Healthcare','Education'};
if (pass == 'acc') {
  List<Account> accs = new List<Account>();
  for (Integer i = fromN; i < toN; i++) {
    String n = String.valueOf(i); while (n.length() < 5) n = '0' + n;
    accs.add(new Account(Name='SFTK VOL Account ' + n, Industry=industries[Math.mod(i, industries.size())], AnnualRevenue=1000 * i, NumberOfEmployees=Math.mod(i, 500), BillingCity='City ' + Math.mod(i, 97), Description='Volume fixture row ' + n));
  }
  Database.insert(accs, dmo);
} else if (pass == 'con') {
  String lo = pad(fromN), hi = pad(toN);
  List<Account> accs = [SELECT Id, Name FROM Account WHERE Name >= :('SFTK VOL Account ' + lo) AND Name < :('SFTK VOL Account ' + hi) ORDER BY Name];
  List<Contact> cons = new List<Contact>();
  for (Account a : accs) {
    String n = a.Name.substringAfterLast(' ');
    cons.add(new Contact(FirstName='Vol', LastName='SFTK VOL Contact ' + n + 'A', AccountId=a.Id, Email='vol' + n + 'a@sftk-vol.example', Title='Buyer'));
    cons.add(new Contact(FirstName='Vol', LastName='SFTK VOL Contact ' + n + 'B', AccountId=a.Id, Email='vol' + n + 'b@sftk-vol.example', Title='User'));
  }
  Database.insert(cons, dmo);
} else if (pass == 'opp') {
  String lo = pad(fromN), hi = pad(toN);
  List<Account> accs = [SELECT Id, Name FROM Account WHERE Name >= :('SFTK VOL Account ' + lo) AND Name < :('SFTK VOL Account ' + hi) ORDER BY Name];
  List<Opportunity> opps = new List<Opportunity>();
  for (Account a : accs) {
    String n = a.Name.substringAfterLast(' ');
    opps.add(new Opportunity(Name='SFTK VOL Opp ' + n, AccountId=a.Id, StageName='Prospecting', CloseDate=Date.today().addDays(30), Amount=100 + Integer.valueOf(n)));
  }
  Database.insert(opps, dmo);
}
System.debug('SFTK VOL pass ' + pass + ' ' + fromN + '-' + toN + ' done');
