
import csv
import sys
import os

CSV_FILE = os.environ.get('ORDERS_EXPORT_CSV', os.path.join(os.getcwd(), 'artifacts', 'orders_export.csv'))

def main():
    if not os.path.exists(CSV_FILE):
        print(f"Error: {CSV_FILE} not found.")
        sys.exit(1)

    print(f"Simulating user filling '1' in '已发货' column for {CSV_FILE}...")
    
    rows = []
    header = []

    with open(CSV_FILE, 'r', encoding='utf-8-sig') as f:
        reader = csv.reader(f)
        try:
            header = next(reader)
        except StopIteration:
            print("Empty CSV file.")
            sys.exit(1)
        
        # Find '已发货' column index
        try:
            shipped_idx = header.index('已发货')
        except ValueError:
            print("Error: Column '已发货' not found in CSV.")
            sys.exit(1)
            
        for row in reader:
            if len(row) > shipped_idx:
                row[shipped_idx] = '1'
            rows.append(row)

    # Write back
    with open(CSV_FILE, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)
        
    print(f"Updated {len(rows)} rows with '1' in '已发货' column.")

if __name__ == "__main__":
    main()
