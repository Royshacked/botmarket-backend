export function makeId(length = 5) {
	var txt = ''
	var possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
	for (let i = 0; i < length; i++) {
		txt += possible.charAt(Math.floor(Math.random() * possible.length))
	}
	return txt
}

export function getStartOfTodayUTC() {
	const now = new Date();
	return Date.UTC(
	  now.getUTCFullYear(),
	  now.getUTCMonth(),
	  now.getUTCDate()
	) / 1000; // convert to seconds
  }